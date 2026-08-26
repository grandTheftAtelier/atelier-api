/**
 * atelier-api — backend for "atelier by feelgood" (GTA V addon-clothing tool).
 * Bun.serve, no framework. See README.md for architecture + auth flow.
 */

import pkg from "../package.json";
import { loadEnv, isDevFakeAuthActive } from "./env";
import { configureMongo, ensureIndexes } from "./mongodb";
import { configureCas, ensureCasDirs } from "./storage/cas";
import { Router } from "./router";
import { configureClientIp, json, recordSocketIp } from "./http";
import { requireService } from "./auth/require";
import { registerAuthRoutes } from "./routes/auth";
import { registerDeviceRoutes } from "./routes/devices";
import { registerMeRoutes } from "./routes/me";
import { registerAdminRoutes } from "./routes/admin";
import { registerUploadRoutes } from "./routes/uploads";
import { registerAssetRoutes } from "./routes/assets";
import { registerPackRoutes } from "./routes/packs";
import { registerPresenceRoutes } from "./routes/presence";
import { registerLockRoutes } from "./routes/locks";
import { registerWorkspaceRoutes } from "./routes/workspaces";
import { htmlPage } from "./web/pages";
import { startUpdateChecks, getUpdateStatus, checkForUpdate } from "./version-check";
import { registerBuildRoutes } from "./routes/builds";
import { registerRegistryRoutes } from "./routes/registry";
import { registerImportCreativeRoutes } from "./routes/import-creative";
import { registerAdminWebRoutes } from "./routes/admin-web";
import { configureBuildQueue } from "./builds/queue";
import { log } from "./logging/log";
import {
  collabWebsocket,
  configureCollab,
  handleWsUpgrade,
  startLockExpirySweep,
} from "./ws/collab";

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, range, if-none-match, x-fg-service-token",
};

function withCors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    res.headers.set(k, v);
  }
  return res;
}

async function main() {
  const env = loadEnv();
  configureMongo(env);

  // CAS storage layout (cas/ + tmp/) under ATELIER_STORAGE_ROOT.
  configureCas(env);
  try {
    ensureCasDirs();
  } catch (e) {
    console.warn("[atelier-api] could not create storage directories:", e);
  }

  const router = new Router(env);

  router.get("/health", () => {
    const u = getUpdateStatus();
    return json({
      ok: true,
      service: "atelier-api",
      version: pkg.version,
      updateAvailable: u.updateAvailable,
      latestVersion: u.latest,
    });
  });

  // Update status — the desktop app / monitoring reads this to show a
  // "server update available" hint. `?refresh=1` forces a fresh check.
  router.get("/api/v1/version", async ({ url }) => {
    if (url.searchParams.get("refresh") === "1") await checkForUpdate();
    return json(getUpdateStatus());
  });

  // Browser-facing landing page (humans hitting the base URL).
  router.get("/", () => {
    const u = getUpdateStatus();
    return htmlPage({
      title: "atelier-api",
      heading: "atelier-api is running",
      message: u.updateAvailable
        ? `An update is available (running v${u.current}, latest v${u.latest}). Redeploy this server to update.`
        : "This is the sync server for the atelier desktop app. Nothing to see here — the magic happens in the app.",
      variant: u.updateAvailable ? "info" : "ok",
      badge: u.updateAvailable ? `v${u.current} · update available` : `v${pkg.version}`,
    });
  });

  // Logo for the HTML pages + the app's loopback success page.
  const logoFile = Bun.file(new URL("../assets/atelier-logo.png", import.meta.url));
  router.get("/logo.png", async () =>
    (await logoFile.exists())
      ? new Response(logoFile, {
          headers: {
            "content-type": "image/png",
            "cache-control": "public, max-age=86400",
          },
        })
      : json({ error: "not_found" }, 404),
  );

  // Hero video backdrop for the browser-facing HTML pages (same origin).
  const heroFile = Bun.file(new URL("../assets/hero-desktop.webm", import.meta.url));
  router.get("/hero.webm", async () =>
    (await heroFile.exists())
      ? new Response(heroFile, {
          headers: {
            "content-type": "video/webm",
            "cache-control": "public, max-age=86400",
          },
        })
      : json({ error: "not_found" }, 404),
  );

  // Service-to-service probe (header x-fg-service-token) — consumers come later.
  router.get("/api/v1/internal/ping", ({ req }) => {
    const fail = requireService(req, env);
    if (fail) return fail;
    return json({ ok: true, service: "atelier-api" });
  });

  registerAuthRoutes(router, env);
  registerDeviceRoutes(router, env);
  registerMeRoutes(router, env);
  registerAdminRoutes(router, env);
  registerUploadRoutes(router, env);
  registerAssetRoutes(router, env);
  registerPackRoutes(router, env);
  registerPresenceRoutes(router, env);
  registerLockRoutes(router, env);
  registerWorkspaceRoutes(router, env);
  registerBuildRoutes(router, env);
  registerRegistryRoutes(router, env);
  registerImportCreativeRoutes(router, env);
  registerAdminWebRoutes(router, env);

  configureClientIp(env.ATELIER_TRUST_PROXY);
  configureCollab(env);
  configureBuildQueue(env);
  startLockExpirySweep();
  startUpdateChecks();

  const server = Bun.serve({
    hostname: env.HOST,
    port: env.PORT,
    async fetch(req, srv) {
      const url = new URL(req.url);

      // Socket peer address for rate limiting (X-Forwarded-For is spoofable).
      recordSocketIp(req, srv.requestIP(req)?.address);

      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      // WebSocket upgrade — must return undefined for the upgraded connection.
      if (req.method === "GET" && url.pathname === "/api/v1/ws") {
        const res = await handleWsUpgrade(req, url, srv);
        return res ? withCors(res) : undefined;
      }

      try {
        const res = await router.handle(req, url);
        if (res) return withCors(res);
        return withCors(json({ error: "not_found" }, 404));
      } catch (e) {
        console.error(`[atelier-api] ${req.method} ${url.pathname} failed:`, e);
        return withCors(json({ error: "internal_error" }, 500));
      }
    },
    websocket: collabWebsocket,
  });

  log.info(
    "server",
    `v${pkg.version} running on http://${server.hostname}:${server.port} ` +
      `(fakeAuth=${isDevFakeAuthActive(env)}, admins=${env.ATELIER_ADMIN_DISCORD_IDS.length})`,
  );

  // Ensure indexes in the background — a remote Atlas cluster being briefly
  // unreachable must not prevent the service from starting.
  ensureIndexes()
    .then(() => console.log("[atelier-api] mongo indexes ensured"))
    .catch((e) => console.warn("[atelier-api] ensureIndexes failed (mongo unreachable?):", e?.message ?? e));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
