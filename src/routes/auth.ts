/**
 * Discord OAuth (scope: identify) for the desktop app.
 *
 * Flow (real mode):
 *   1. App opens GET /api/v1/auth/discord/start?redirect_uri=http://127.0.0.1:<port>/callback
 *   2. Service signs a state token (carries the app redirect_uri), sets a nonce
 *      cookie and 302s to discord.com/oauth2/authorize.
 *   3. Discord redirects to {ATELIER_PUBLIC_ORIGIN}/api/v1/auth/discord/callback.
 *   4. Callback verifies state+nonce, exchanges the code, fetches /users/@me,
 *      upserts atelierUsers, creates a one-time code (TTL 60s) and 302s to
 *      {app redirect_uri}?code=...
 *
 * DEV FAKE MODE (ATELIER_DEV_FAKE_AUTH=1 + Discord creds CHANGEME, never in
 * production): /start skips Discord entirely, upserts the fake user and
 * redirects immediately with a one-time code. Optional &dev_id= / &dev_username=
 * overrides (fake mode only) allow multi-user E2E testing.
 */

import { randomBytes } from "node:crypto";
import type { Router } from "../router";
import { redirect, isLoopbackRedirectUri, parseCookies } from "../http";
import { htmlAuthError } from "../web/pages";
import { hasDiscordCredentials, isDevFakeAuthActive, type Env } from "../env";
import { signJwt, verifyJwt } from "../auth/jwt";
import { upsertLoginUser } from "../models/atelierUser";
import { notifyPendingUser } from "../notify/discord";
import { createAuthCode } from "../models/authCode";
import { logActivity } from "../models/activity";

const STATE_COOKIE = "atelier_oauth_nonce";
const STATE_TTL_SEC = 600;

interface OAuthState {
  /** Token type discriminator — prevents cross-use with access JWTs. */
  typ: "state";
  ru: string; // app redirect_uri (loopback)
  n: string; // nonce, bound to the browser via cookie
  exp: number;
}

function discordCallbackUrl(env: Env): string {
  return `${env.ATELIER_PUBLIC_ORIGIN}/api/v1/auth/discord/callback`;
}

function stateCookie(value: string, maxAge: number): string {
  return `${STATE_COOKIE}=${value}; Path=/api/v1/auth; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

async function issueCodeAndRedirect(
  env: Env,
  discordId: string,
  username: string,
  avatar: string | null,
  redirectUri: string,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const user = await upsertLoginUser(env, discordId, username, avatar);
  const code = await createAuthCode(user.discordId, redirectUri);
  void logActivity("user_login", user.discordId, { username: user.username });

  // First-ever login of a non-admin lands as `pending`: on insert both stamps
  // come from the same `now`, so equal timestamps + pending status means this
  // is a brand-new access request — ping the admins in Discord (opt-in).
  if (
    user.status === "pending" &&
    user.createdAt.getTime() === user.lastLoginAt.getTime()
  ) {
    void notifyPendingUser({ discordId: user.discordId, username: user.username });
  }
  const target = new URL(redirectUri);
  target.searchParams.set("code", code);
  return redirect(target.toString(), extraHeaders);
}

export function registerAuthRoutes(router: Router, env: Env): void {
  // ---------------------------------------------------------------- /start
  // Browser-visited endpoint: errors render as styled HTML pages, not JSON.
  router.get("/api/v1/auth/discord/start", async ({ req, url }) => {
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    if (!isLoopbackRedirectUri(redirectUri)) {
      return htmlAuthError(
        400,
        "The return address is invalid. Please start the sign-in again from the atelier app.",
        "invalid_redirect_uri",
      );
    }

    // --- Dev fake mode: no Discord round-trip --------------------------
    if (isDevFakeAuthActive(env)) {
      const devIdOverride = url.searchParams.get("dev_id") ?? "";
      const devId = devIdOverride || env.ATELIER_DEV_FAKE_DISCORD_ID;
      if (!devId || !/^\d{5,25}$/u.test(devId)) {
        return htmlAuthError(
          500,
          "The dev fake login is not fully configured (ATELIER_DEV_FAKE_DISCORD_ID is missing).",
          "dev_fake_discord_id_not_configured",
        );
      }
      const devUsername = url.searchParams.get("dev_username") || "DevUser";
      console.log(`[atelier-api] DEV FAKE AUTH login for discordId=${devId}`);
      return issueCodeAndRedirect(env, devId, devUsername, null, redirectUri);
    }

    // --- Real Discord OAuth --------------------------------------------
    if (!hasDiscordCredentials(env)) {
      return htmlAuthError(
        500,
        "Discord sign-in is not configured on this server yet. Please contact the admin.",
        "discord_not_configured",
      );
    }

    const nonce = randomBytes(16).toString("hex");
    const state: OAuthState = {
      typ: "state",
      ru: redirectUri,
      n: nonce,
      exp: Math.floor(Date.now() / 1000) + STATE_TTL_SEC,
    };
    const stateToken = signJwt(state as unknown as Record<string, unknown>, env.ATELIER_JWT_SECRET);

    const authorize = new URL("https://discord.com/oauth2/authorize");
    authorize.searchParams.set("client_id", env.ATELIER_DISCORD_CLIENT_ID);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", "identify");
    authorize.searchParams.set("redirect_uri", discordCallbackUrl(env));
    authorize.searchParams.set("state", stateToken);
    authorize.searchParams.set("prompt", "none");

    return redirect(authorize.toString(), {
      "set-cookie": stateCookie(nonce, STATE_TTL_SEC),
    });
  });

  // ------------------------------------------------------------- /callback
  // Browser-visited endpoint: errors render as styled HTML pages, not JSON.
  router.get("/api/v1/auth/discord/callback", async ({ req, url }) => {
    const retryHint =
      "Please start the sign-in again from the atelier app — the process has expired or is incomplete.";
    const code = url.searchParams.get("code") ?? "";
    const stateToken = url.searchParams.get("state") ?? "";
    if (!code || !stateToken) return htmlAuthError(400, retryHint, "missing_code_or_state");

    const state = verifyJwt<OAuthState>(stateToken, env.ATELIER_JWT_SECRET);
    if (!state || state.typ !== "state" || typeof state.ru !== "string" || typeof state.n !== "string") {
      return htmlAuthError(400, retryHint, "invalid_state");
    }
    const cookies = parseCookies(req);
    if (cookies[STATE_COOKIE] !== state.n) {
      return htmlAuthError(400, retryHint, "invalid_state");
    }
    if (!isLoopbackRedirectUri(state.ru)) {
      return htmlAuthError(400, retryHint, "invalid_redirect_uri");
    }

    // Exchange the authorization code for an access token.
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.ATELIER_DISCORD_CLIENT_ID,
        client_secret: env.ATELIER_DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: discordCallbackUrl(env),
      }),
    });
    if (!tokenRes.ok) {
      console.error("[atelier-api] discord token exchange failed:", tokenRes.status, await tokenRes.text());
      return htmlAuthError(
        502,
        "Discord did not confirm the sign-in. Please try again in a moment.",
        "discord_token_exchange_failed",
      );
    }
    const tokenBody = (await tokenRes.json()) as { access_token?: string };
    if (!tokenBody.access_token) {
      return htmlAuthError(
        502,
        "Discord did not confirm the sign-in. Please try again in a moment.",
        "discord_token_exchange_failed",
      );
    }

    // Fetch the Discord profile (scope identify).
    const meRes = await fetch("https://discord.com/api/users/@me", {
      headers: { authorization: `Bearer ${tokenBody.access_token}` },
    });
    if (!meRes.ok) {
      console.error("[atelier-api] discord /users/@me failed:", meRes.status);
      return htmlAuthError(
        502,
        "Your Discord profile could not be loaded. Please try again in a moment.",
        "discord_user_fetch_failed",
      );
    }
    const me = (await meRes.json()) as {
      id: string;
      username: string;
      global_name?: string | null;
      avatar?: string | null;
    };

    const username = me.global_name || me.username;
    const avatar = me.avatar
      ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png`
      : null;

    // Clear the nonce cookie on the way out.
    return issueCodeAndRedirect(env, me.id, username, avatar, state.ru, {
      "set-cookie": stateCookie("", 0),
    });
  });
}
