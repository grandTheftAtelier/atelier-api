/**
 * Web admin dashboard — browser routes + its JSON API.
 *
 *   HTML:  GET /admin            login page or dashboard (cookie session)
 *          GET /admin/login      -> Discord OAuth (or dev-fake login)
 *          GET /admin/callback   <- Discord; admin-gated; sets session cookie
 *          GET /admin/logout     clears the session
 *          GET /admin/app.css|js static dashboard assets
 *
 *   JSON (cookie-authed, /api/v1/admin/web/*): overview, activity, logs(+SSE),
 *          packs, pack detail, trigger build, build-config, builds list,
 *          artifact download, user approve/lock.
 *
 * Access is gated on ATELIER_ADMIN_DISCORD_IDS, re-checked every request. This
 * is fully separate from the desktop device-token admin lane in routes/admin.ts.
 */

import pkg from "../../package.json";
import { col } from "../mongodb";
import type { Router } from "../router";
import { hasDiscordCredentials, isDevFakeAuthActive, type Env } from "../env";
import { json, err, redirect, readJsonBody } from "../http";
import {
  readAdminSession,
  signAdminSession,
  setSessionCookie,
  clearSessionCookie,
  createAdminState,
  verifyAdminState,
  clearStateCookie,
  adminCallbackUrl,
  isSameOrigin,
  type AdminWebSession,
} from "../auth/admin-web";
import { discordAuthorizeUrl, exchangeDiscordCode, fetchDiscordProfile } from "../auth/discord";
import {
  isEnvAdmin,
  usersCol,
  upsertLoginUser,
  type AtelierUser,
  type AtelierUserStatus,
} from "../models/atelierUser";
import { revokeAllDevicesForUser } from "../auth/device-auth";
import { kickUserEverywhere } from "../ws/collab";
import { logActivity, type AtelierActivity } from "../models/activity";
import { packsCol, type AtelierPackBuildConfig } from "../models/atelierPack";
import { revisionsCol } from "../models/atelierRevision";
import { buildsCol } from "../models/atelierBuild";
import { ensureBuild, forceRebuild } from "../builds/queue";
import { artifactResponse } from "./builds";
import { computeStorageStats } from "../storage/stats";
import { collectGarbage } from "../storage/gc";
import { isNotifierConfigured } from "../notify/discord";
import { recentLogs, subscribeLogs } from "../logging/log";
import { DEFAULT_FXMANIFEST_TEMPLATE } from "../cloth/fivem-export";
import { renderAdminDashboard, renderAdminLogin, adminHtml } from "../web/admin/pages";
import { getUpdateStatus } from "../version-check";

const startedAt = Date.now();
const MAX_TEMPLATE_LEN = 20000;
const MAX_RESOURCE_NAME_LEN = 80;

/** Read-gate: valid admin session or a 401 Response. */
function gate(req: Request, env: Env): AdminWebSession | Response {
  return readAdminSession(req, env) ?? err("unauthorized", 401);
}

/** Mutation-gate: read-gate + same-origin (CSRF defense-in-depth). */
function gateMutation(req: Request, env: Env): AdminWebSession | Response {
  const s = readAdminSession(req, env);
  if (!s) return err("unauthorized", 401);
  if (!isSameOrigin(req, env)) return err("forbidden", 403);
  return s;
}

/** 302 with one or more Set-Cookie headers (redirect() only takes a flat map). */
function redirectWithCookies(location: string, cookies: string[]): Response {
  const headers = new Headers({ location });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}

export function registerAdminWebRoutes(router: Router, env: Env): void {
  /* ============================================================ HTML pages */

  router.get("/admin", ({ req }) => {
    const s = readAdminSession(req, env);
    return adminHtml(s ? renderAdminDashboard(s, pkg.version, getUpdateStatus()) : renderAdminLogin());
  });

  router.get("/admin/login", async ({ req }) => {
    if (readAdminSession(req, env)) return redirect("/admin");

    // Dev fake auth (loopback only): log straight in if the fake id is an admin.
    if (isDevFakeAuthActive(env)) {
      const id = env.ATELIER_DEV_FAKE_DISCORD_ID;
      if (!id || !isEnvAdmin(env, id)) {
        return adminHtml(
          renderAdminLogin({ error: "Dev fake login: ATELIER_DEV_FAKE_DISCORD_ID is not an admin." }),
          403,
        );
      }
      const user = await upsertLoginUser(env, id, "DevAdmin", null);
      void logActivity("admin_web_login", id, { username: user.username, dev: true });
      const token = signAdminSession(env, { discordId: id, username: user.username, avatar: user.avatar });
      return redirectWithCookies("/admin", [setSessionCookie(env, token)]);
    }

    if (!hasDiscordCredentials(env)) {
      return adminHtml(
        renderAdminLogin({ error: "Discord login is not configured on this server." }),
        500,
      );
    }
    const { state, cookie } = createAdminState(env);
    return redirectWithCookies(discordAuthorizeUrl(env, adminCallbackUrl(env), state), [cookie]);
  });

  router.get("/admin/callback", async ({ req, url }) => {
    const clearState = clearStateCookie(env);
    const fail = (status: number, msg: string) =>
      adminHtml(renderAdminLogin({ error: msg }), status, { "set-cookie": clearState });

    const code = url.searchParams.get("code") ?? "";
    const stateToken = url.searchParams.get("state") ?? "";
    if (!code || !stateToken || !verifyAdminState(req, env, stateToken)) {
      return fail(400, "Login expired or invalid. Please try again.");
    }

    const accessToken = await exchangeDiscordCode(env, code, adminCallbackUrl(env));
    if (!accessToken) return fail(502, "Discord did not confirm the sign-in. Please try again.");

    const profile = await fetchDiscordProfile(accessToken);
    if (!profile) return fail(502, "Your Discord profile could not be loaded. Please try again.");

    if (!isEnvAdmin(env, profile.id)) {
      void logActivity("admin_web_denied", profile.id, { username: profile.username });
      return fail(403, "No access — your Discord account is not a server admin.");
    }

    const user = await upsertLoginUser(env, profile.id, profile.username, profile.avatar);
    void logActivity("admin_web_login", profile.id, { username: user.username });
    const token = signAdminSession(env, {
      discordId: user.discordId,
      username: user.username,
      avatar: user.avatar,
    });
    return redirectWithCookies("/admin", [setSessionCookie(env, token), clearState]);
  });

  router.get("/admin/logout", () => redirectWithCookies("/admin", [clearSessionCookie(env)]));

  // Static dashboard assets (resolved relative to this module).
  const cssFile = Bun.file(new URL("../../assets/admin/app.css", import.meta.url));
  const jsFile = Bun.file(new URL("../../assets/admin/app.js", import.meta.url));
  const staticAsset = async (file: Bun.BunFile, type: string): Promise<Response> =>
    (await file.exists())
      ? new Response(file, { headers: { "content-type": type, "cache-control": "no-cache" } })
      : err("not_found", 404);
  router.get("/admin/app.css", () => staticAsset(cssFile, "text/css; charset=utf-8"));
  router.get("/admin/app.js", () => staticAsset(jsFile, "text/javascript; charset=utf-8"));

  /* ========================================================= JSON dashboard */
  const P = "/api/v1/admin/web";

  // ------------------------------------------------------------- overview
  router.get(`${P}/overview`, async ({ req }) => {
    const s = gate(req, env);
    if (s instanceof Response) return s;

    const users = await usersCol();
    const builds = await buildsCol();
    const packs = await packsCol();
    const revisions = await revisionsCol();
    const assets = await col("atelierAssets");

    const [
      storage,
      usersTotal, usersApproved, usersPending, usersLocked,
      packsCount, revisionsCount,
      buildsTotal, buildsDone, buildsError,
      assetsCount,
    ] = await Promise.all([
      computeStorageStats(),
      users.countDocuments({}),
      users.countDocuments({ status: "approved" }),
      users.countDocuments({ status: "pending" }),
      users.countDocuments({ status: "locked" }),
      packs.countDocuments({ archivedAt: null }),
      revisions.countDocuments({}),
      builds.countDocuments({}),
      builds.countDocuments({ status: "done" }),
      builds.countDocuments({ status: "error" }),
      assets.countDocuments({}),
    ]);

    return json({
      version: pkg.version,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      notifierConfigured: isNotifierConfigured(),
      storage,
      counts: {
        users: { total: usersTotal, approved: usersApproved, pending: usersPending, locked: usersLocked },
        packs: packsCount,
        revisions: revisionsCount,
        builds: { total: buildsTotal, done: buildsDone, error: buildsError },
        assets: assetsCount,
      },
    });
  });

  // ---------------------------------------------------------- storage GC
  // Read-only preview of what a cleanup would reclaim.
  router.get(`${P}/storage/gc`, async ({ req }) => {
    const s = gate(req, env);
    if (s instanceof Response) return s;
    const report = await collectGarbage({ dryRun: true });
    return json(report);
  });

  // Perform the cleanup (same-origin gated). Optional `{ graceHours }` overrides
  // the default 48 h safety window (clamped to at least 1 h).
  router.post(`${P}/storage/gc`, async ({ req }) => {
    const s = gateMutation(req, env);
    if (s instanceof Response) return s;
    const body = (await readJsonBody(req)) ?? {};
    let graceMs: number | undefined;
    if (typeof body.graceHours === "number" && Number.isFinite(body.graceHours)) {
      graceMs = Math.max(1, body.graceHours) * 3.6e6;
    }
    const report = await collectGarbage({ dryRun: false, graceMs });
    void logActivity("admin_storage_gc", s.discordId, {
      totalCount: report.totalCount,
      totalBytes: report.totalBytes,
      orphanAssets: report.orphanAssets.count,
      staleTmp: report.staleTmp.count,
      orphanBuilds: report.orphanBuilds.count,
    });
    return json(report);
  });

  // ------------------------------------------------------------- activity
  router.get(`${P}/activity`, async ({ req, url }) => {
    const s = gate(req, env);
    if (s instanceof Response) return s;
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "100", 10) || 100, 1), 500);
    const activity = await col<AtelierActivity>("atelierActivity");
    const items = await activity.find({}).sort({ ts: -1 }).limit(limit).toArray();
    return json({ items: items.map((a) => ({ type: a.type, actorDiscordId: a.actorDiscordId, ts: a.ts, data: a.data })) });
  });

  // ----------------------------------------------------------------- logs
  router.get(`${P}/logs`, ({ req }) => {
    const s = gate(req, env);
    if (s instanceof Response) return s;
    return json({ items: recentLogs(500) });
  });

  // SSE live tail of the server log ring buffer.
  router.get(`${P}/logs/stream`, ({ req }) => {
    const s = gate(req, env);
    if (s instanceof Response) return s;
    const enc = new TextEncoder();
    let unsub: (() => void) | null = null;
    let ka: ReturnType<typeof setInterval> | null = null;
    const stream = new ReadableStream({
      start(controller) {
        const safeEnqueue = (chunk: string) => {
          try {
            controller.enqueue(enc.encode(chunk));
          } catch {
            cleanup();
          }
        };
        const cleanup = () => {
          if (unsub) { unsub(); unsub = null; }
          if (ka) { clearInterval(ka); ka = null; }
        };
        unsub = subscribeLogs((e) => safeEnqueue(`data: ${JSON.stringify(e)}\n\n`));
        ka = setInterval(() => safeEnqueue(`: ping\n\n`), 25000);
        safeEnqueue(`: connected\n\n`);
      },
      cancel() {
        if (unsub) { unsub(); unsub = null; }
        if (ka) { clearInterval(ka); ka = null; }
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  });

  // ---------------------------------------------------------------- packs
  router.get(`${P}/packs`, async ({ req }) => {
    const s = gate(req, env);
    if (s instanceof Response) return s;
    const packs = await packsCol();
    const list = await packs.find({ archivedAt: null }).sort({ updatedAt: -1 }).limit(500).toArray();
    return json({
      packs: list.map((p) => ({
        packId: p.packId,
        name: p.name,
        slug: p.slug,
        ownerDiscordId: p.ownerDiscordId,
        headRevision: p.headRevision,
        hasBuildConfig: !!(p.buildConfig && (p.buildConfig.resourceName || p.buildConfig.fxmanifestTemplate)),
      })),
    });
  });

  router.get(`${P}/packs/:packId`, async ({ req, params }) => {
    const s = gate(req, env);
    if (s instanceof Response) return s;
    const packs = await packsCol();
    const pack = await packs.findOne({ packId: params.packId! });
    if (!pack || pack.archivedAt) return err("pack_not_found", 404);

    const revisions = await revisionsCol();
    const revs = await revisions
      .find({ packId: pack.packId })
      .project({ revision: 1, message: 1, createdAt: 1, dlcName: 1, "stats.drawableCount": 1 })
      .sort({ revision: -1 })
      .limit(100)
      .toArray();

    const builds = await buildsCol();
    const buildDocs = await builds.find({ packId: pack.packId }).sort({ revision: -1 }).toArray();

    return json({
      pack: {
        packId: pack.packId,
        name: pack.name,
        slug: pack.slug,
        ownerDiscordId: pack.ownerDiscordId,
        headRevision: pack.headRevision,
      },
      revisions: revs.map((r) => ({
        revision: (r as { revision: number }).revision,
        message: (r as { message?: string }).message ?? "",
        dlcName: (r as { dlcName?: string | null }).dlcName ?? null,
        drawableCount: (r as { stats?: { drawableCount?: number } }).stats?.drawableCount ?? null,
      })),
      builds: buildDocs.map((b) => ({
        buildId: b.buildId,
        revision: b.revision,
        status: b.status,
        sizeBytes: b.sizeBytes,
        finishedAt: b.finishedAt,
        error: b.error,
      })),
      buildConfig: pack.buildConfig ?? null,
      defaultTemplate: DEFAULT_FXMANIFEST_TEMPLATE,
    });
  });

  // -------------------------------------------------- trigger a server build
  router.post(`${P}/packs/:packId/builds`, async ({ req, params }) => {
    const s = gateMutation(req, env);
    if (s instanceof Response) return s;
    const packs = await packsCol();
    const pack = await packs.findOne({ packId: params.packId! });
    if (!pack || pack.archivedAt) return err("pack_not_found", 404);

    const body = await readJsonBody(req);
    if (!body) return err("invalid_json", 400);

    let revisionNo: number;
    if (body.revision === "head") {
      if (pack.headRevision === 0) return err("no_revisions", 404);
      revisionNo = pack.headRevision;
    } else if (typeof body.revision === "number" && Number.isInteger(body.revision) && body.revision >= 1) {
      revisionNo = body.revision;
    } else {
      return err("invalid_revision", 400);
    }

    const revisions = await revisionsCol();
    const exists = await revisions.findOne(
      { packId: pack.packId, revision: revisionNo },
      { projection: { revision: 1 } },
    );
    if (!exists) return err("revision_not_found", 404);

    const force = body.force === true;
    const build = force
      ? await forceRebuild(pack.packId, revisionNo, s.discordId)
      : await ensureBuild(pack.packId, revisionNo, s.discordId);
    return json(
      { build: { buildId: build.buildId, revision: build.revision, status: build.status } },
      build.status === "done" ? 200 : 202,
    );
  });

  // ------------------------------------------------------- build-config (PUT)
  router.put(`${P}/packs/:packId/build-config`, async ({ req, params }) => {
    const s = gateMutation(req, env);
    if (s instanceof Response) return s;
    const body = await readJsonBody(req);
    if (!body) return err("invalid_json", 400);

    const resourceName = typeof body.resourceName === "string" ? body.resourceName.trim() : "";
    const fxmanifestTemplate = typeof body.fxmanifestTemplate === "string" ? body.fxmanifestTemplate : "";
    if (resourceName.length > MAX_RESOURCE_NAME_LEN) return err("resource_name_too_long", 400);
    if (fxmanifestTemplate.length > MAX_TEMPLATE_LEN) return err("template_too_long", 400);

    const packs = await packsCol();
    const pack = await packs.findOne({ packId: params.packId! }, { projection: { packId: 1, archivedAt: 1 } });
    if (!pack || pack.archivedAt) return err("pack_not_found", 404);

    const tpl = fxmanifestTemplate.trim();
    const hasConfig = resourceName !== "" || tpl !== "";
    const buildConfig: AtelierPackBuildConfig | null = hasConfig
      ? {
          ...(resourceName ? { resourceName } : {}),
          ...(tpl ? { fxmanifestTemplate: tpl } : {}),
          updatedAt: new Date(),
          updatedByDiscordId: s.discordId,
        }
      : null;

    await packs.updateOne({ packId: params.packId! }, { $set: { buildConfig, updatedAt: new Date() } });
    void logActivity("admin_build_config", s.discordId, { packId: params.packId, cleared: !hasConfig });
    return json({ buildConfig });
  });

  // --------------------------------------------------------------- builds
  router.get(`${P}/builds`, async ({ req }) => {
    const s = gate(req, env);
    if (s instanceof Response) return s;
    const builds = await buildsCol();
    const list = await builds.find({}).sort({ createdAt: -1 }).limit(200).toArray();
    const packIds = [...new Set(list.map((b) => b.packId))];
    const packs = await packsCol();
    const packDocs = packIds.length
      ? await packs.find({ packId: { $in: packIds } }).project({ packId: 1, name: 1 }).toArray()
      : [];
    const nameById = new Map(packDocs.map((p) => [(p as { packId: string }).packId, (p as { name?: string }).name]));
    return json({
      builds: list.map((b) => ({
        buildId: b.buildId,
        packId: b.packId,
        packName: nameById.get(b.packId) ?? null,
        revision: b.revision,
        status: b.status,
        sizeBytes: b.sizeBytes,
        finishedAt: b.finishedAt,
        error: b.error,
      })),
    });
  });

  // ----------------------------------------------- download a build artifact
  router.get(`${P}/builds/:buildId/download`, async ({ req, params }) => {
    const s = gate(req, env);
    if (s instanceof Response) return s;
    const builds = await buildsCol();
    const build = await builds.findOne({ buildId: params.buildId! });
    if (!build) return err("build_not_found", 404);
    const packs = await packsCol();
    const pack = await packs.findOne({ packId: build.packId }, { projection: { slug: 1 } });
    const name = `${(pack as { slug?: string } | null)?.slug ?? build.packId}-r${build.revision}.zip`;
    const res = await artifactResponse(build, name);
    if (!res) return err("build_not_done", 409);
    return res;
  });

  /* ---------------------------------------------------- user management */
  function adminUserView(u: AtelierUser) {
    return {
      discordId: u.discordId,
      username: u.username,
      avatar: u.avatar,
      status: u.status,
      role: u.role,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
    };
  }

  router.get(`${P}/users`, async ({ req, url }) => {
    const s = gate(req, env);
    if (s instanceof Response) return s;
    const status = url.searchParams.get("status");
    const filter: Record<string, unknown> = {};
    if (status && ["pending", "approved", "locked"].includes(status)) filter.status = status as AtelierUserStatus;
    const users = await usersCol();
    const list = await users.find(filter).sort({ createdAt: -1 }).limit(500).toArray();
    return json({ users: list.map(adminUserView) });
  });

  router.post(`${P}/users/:discordId/approve`, async ({ req, params }) => {
    const s = gateMutation(req, env);
    if (s instanceof Response) return s;
    const users = await usersCol();
    const result = await users.findOneAndUpdate(
      { discordId: params.discordId! },
      { $set: { status: "approved", approvedByDiscordId: s.discordId, approvedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!result) return err("user_not_found", 404);
    void logActivity("user_approved", s.discordId, { discordId: result.discordId, via: "web" });
    return json({ user: adminUserView(result) });
  });

  router.post(`${P}/users/:discordId/lock`, async ({ req, params }) => {
    const s = gateMutation(req, env);
    if (s instanceof Response) return s;
    const discordId = params.discordId!;
    if (isEnvAdmin(env, discordId)) return err("cannot_lock_env_admin", 400);
    const users = await usersCol();
    const result = await users.findOneAndUpdate(
      { discordId },
      { $set: { status: "locked" } },
      { returnDocument: "after" },
    );
    if (!result) return err("user_not_found", 404);
    const revokedDevices = await revokeAllDevicesForUser(discordId);
    await kickUserEverywhere(discordId);
    void logActivity("user_locked", s.discordId, { discordId, revokedDevices, via: "web" });
    return json({ user: adminUserView(result), revokedDevices });
  });

  router.post(`${P}/users/:discordId/role`, async ({ req, params }) => {
    const s = gateMutation(req, env);
    if (s instanceof Response) return s;
    const body = await readJsonBody(req);
    if (!body || (body.role !== "admin" && body.role !== "member")) return err("invalid_role", 400);
    const discordId = params.discordId!;
    // Env-configured admins are forced to role=admin on every request, so a
    // web demotion would silently bounce back — reject it up front.
    if (isEnvAdmin(env, discordId)) return err("cannot_change_env_admin", 400);
    const users = await usersCol();
    const result = await users.findOneAndUpdate(
      { discordId },
      { $set: { role: body.role } },
      { returnDocument: "after" },
    );
    if (!result) return err("user_not_found", 404);
    void logActivity("user_role", s.discordId, { discordId, role: body.role, via: "web" });
    return json({ user: adminUserView(result) });
  });
}
