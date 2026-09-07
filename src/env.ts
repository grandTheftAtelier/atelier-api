/**
 * Typed environment loading with defaults + validation.
 * Fails fast (throws) on missing/invalid required variables.
 * No external deps — plain parsing helpers.
 */

export interface Env {
  HOST: string;
  PORT: number;
  MONGODB_URI: string;
  MONGODB_DB_NAME: string;
  /** Optional DNS override (e.g. 8.8.8.8) — Bun on Windows sometimes fails mongodb+srv SRV lookups */
  MONGODB_DNS_SERVERS: string[];
  ATELIER_PUBLIC_ORIGIN: string;
  ATELIER_DISCORD_CLIENT_ID: string;
  ATELIER_DISCORD_CLIENT_SECRET: string;
  /** Discord IDs that are always forced to status=approved + role=admin */
  ATELIER_ADMIN_DISCORD_IDS: string[];
  /**
   * Optional Discord webhook URL. When set, the server posts operational
   * notifications there (a new user awaiting approval, a failed server build).
   * Empty = notifications disabled.
   */
  ATELIER_DISCORD_WEBHOOK_URL: string;
  ATELIER_JWT_SECRET: string;
  ATELIER_SERVICE_TOKEN: string;
  ATELIER_STORAGE_ROOT: string;
  /** Server-fixed upload chunk size in bytes — clients must use the value from the upload-init response. */
  ATELIER_MAX_CHUNK_BYTES: number;
  /** Maximum size of a single uploaded asset in bytes. */
  ATELIER_MAX_ASSET_BYTES: number;
  /** Max number of server-side pack builds running concurrently. */
  ATELIER_BUILD_CONCURRENCY: number;
  /**
   * Root of creative's cloth uploads (CLOTH_UPLOAD_ROOT over there) — used by
   * the one-shot creative import. Empty = import endpoint disabled (503).
   */
  ATELIER_CREATIVE_CLOTH_ROOT: string;
  ATELIER_DEV_FAKE_AUTH: boolean;
  ATELIER_DEV_FAKE_DISCORD_ID: string;
  /**
   * Only set to true when deployed BEHIND a reverse proxy: then the rightmost
   * X-Forwarded-For entry (appended by our proxy) is used as the client IP.
   * On direct connections the header is attacker-controlled and ignored.
   */
  ATELIER_TRUST_PROXY: boolean;
}

const PLACEHOLDER = "CHANGEME";

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (v == null || v === "") return fallback;
  return v === "1" || v === "true" || v === "yes";
}

function int(name: string, fallback: number, min: number, max: number, errors: string[]): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    errors.push(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
    return fallback;
  }
  return n;
}

function list(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadEnv(): Env {
  const errors: string[] = [];

  const required = (name: string, minLen = 1): string => {
    const v = process.env[name]?.trim() ?? "";
    if (v.length < minLen) {
      errors.push(
        v === ""
          ? `${name} is required but missing`
          : `${name} must be at least ${minLen} characters`,
      );
    }
    return v;
  };

  const env: Env = {
    HOST: str("HOST", "127.0.0.1"),
    PORT: int("PORT", 3095, 1, 65535, errors),
    MONGODB_URI: required("MONGODB_URI"),
    MONGODB_DB_NAME: str("MONGODB_DB_NAME", "atelier"),
    MONGODB_DNS_SERVERS: list("MONGODB_DNS_SERVERS"),
    ATELIER_PUBLIC_ORIGIN: str("ATELIER_PUBLIC_ORIGIN", "http://127.0.0.1:3095").replace(/\/+$/u, ""),
    ATELIER_DISCORD_CLIENT_ID: str("ATELIER_DISCORD_CLIENT_ID", ""),
    ATELIER_DISCORD_CLIENT_SECRET: str("ATELIER_DISCORD_CLIENT_SECRET", ""),
    ATELIER_ADMIN_DISCORD_IDS: list("ATELIER_ADMIN_DISCORD_IDS"),
    ATELIER_DISCORD_WEBHOOK_URL: str("ATELIER_DISCORD_WEBHOOK_URL", ""),
    ATELIER_JWT_SECRET: required("ATELIER_JWT_SECRET", 32),
    ATELIER_SERVICE_TOKEN: required("ATELIER_SERVICE_TOKEN", 16),
    ATELIER_STORAGE_ROOT: str("ATELIER_STORAGE_ROOT", "./data"),
    ATELIER_MAX_CHUNK_BYTES: int("ATELIER_MAX_CHUNK_BYTES", 8 * 1024 * 1024, 64 * 1024, 256 * 1024 * 1024, errors),
    ATELIER_MAX_ASSET_BYTES: int("ATELIER_MAX_ASSET_BYTES", 268435456, 1024 * 1024, 1024 * 1024 * 1024 * 1024, errors),
    ATELIER_BUILD_CONCURRENCY: int("ATELIER_BUILD_CONCURRENCY", 2, 1, 16, errors),
    ATELIER_CREATIVE_CLOTH_ROOT: str("ATELIER_CREATIVE_CLOTH_ROOT", ""),
    ATELIER_DEV_FAKE_AUTH: bool("ATELIER_DEV_FAKE_AUTH", false),
    ATELIER_DEV_FAKE_DISCORD_ID: str("ATELIER_DEV_FAKE_DISCORD_ID", ""),
    ATELIER_TRUST_PROXY: bool("ATELIER_TRUST_PROXY", false),
  };

  if (env.ATELIER_MAX_CHUNK_BYTES > env.ATELIER_MAX_ASSET_BYTES) {
    errors.push("ATELIER_MAX_CHUNK_BYTES must not exceed ATELIER_MAX_ASSET_BYTES");
  }

  if (env.ATELIER_DISCORD_WEBHOOK_URL) {
    try {
      const hook = new URL(env.ATELIER_DISCORD_WEBHOOK_URL);
      if (hook.protocol !== "https:") {
        errors.push("ATELIER_DISCORD_WEBHOOK_URL must be an https URL");
      }
    } catch {
      errors.push(`ATELIER_DISCORD_WEBHOOK_URL is not a valid URL ("${env.ATELIER_DISCORD_WEBHOOK_URL}")`);
    }
  }

  try {
    const origin = new URL(env.ATELIER_PUBLIC_ORIGIN);
    if (origin.protocol !== "http:" && origin.protocol !== "https:") {
      errors.push("ATELIER_PUBLIC_ORIGIN must be a http(s) URL");
    }
    // Fail closed: fake auth lets anyone mint a session, so it may never run
    // on a non-loopback origin or in production — refuse to start instead of
    // silently deciding at request time.
    if (env.ATELIER_DEV_FAKE_AUTH) {
      const loopback = origin.hostname === "127.0.0.1" || origin.hostname === "localhost";
      if (!loopback) {
        errors.push(
          "ATELIER_DEV_FAKE_AUTH=1 is only allowed when ATELIER_PUBLIC_ORIGIN is a loopback address (127.0.0.1/localhost)",
        );
      }
      if (process.env.NODE_ENV === "production") {
        errors.push("ATELIER_DEV_FAKE_AUTH=1 is not allowed with NODE_ENV=production");
      }
    }
  } catch {
    errors.push(`ATELIER_PUBLIC_ORIGIN is not a valid URL ("${env.ATELIER_PUBLIC_ORIGIN}")`);
  }

  if (errors.length > 0) {
    for (const e of errors) console.error(`[atelier-api] env error: ${e}`);
    throw new Error(`Invalid environment (${errors.length} error(s), see log above)`);
  }

  return env;
}

function isPlaceholder(v: string): boolean {
  return v === "" || v.toUpperCase() === PLACEHOLDER;
}

/** True when Discord credentials are real (not empty / CHANGEME). */
export function hasDiscordCredentials(env: Env): boolean {
  return !isPlaceholder(env.ATELIER_DISCORD_CLIENT_ID) && !isPlaceholder(env.ATELIER_DISCORD_CLIENT_SECRET);
}

/**
 * Dev fake auth is only active when explicitly enabled, NOT in production,
 * and no real Discord credentials are configured (mirror of creative/lib/dev-fake-auth.ts).
 */
export function isDevFakeAuthActive(env: Env): boolean {
  if (process.env.NODE_ENV === "production") return false;
  if (!env.ATELIER_DEV_FAKE_AUTH) return false;
  return !hasDiscordCredentials(env);
}
