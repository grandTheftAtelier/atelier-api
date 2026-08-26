/**
 * E2E smoke test against a RUNNING atelier-api with dev fake auth active.
 *
 *   Terminal 1: bun run dev
 *   Terminal 2: bun run smoke
 *
 * Requires .env.local with ATELIER_DEV_FAKE_AUTH=1, Discord creds CHANGEME and
 * the fake discord id listed in ATELIER_ADMIN_DISCORD_IDS (admin scenario).
 * Exercises: health, fake login (admin + second pending user), code exchange,
 * pending gate, admin approve/lock/role, refresh rotation, logout, service token,
 * CAS chunk uploads (resume + ranged download), packs/revisions (team-wide
 * access: every approved user can list/read/clone any pack, viewer downgrade
 * blocks writes), durable live workspaces, drawable locks + WebSocket collab
 * (rooms, presence, lock/workspace broadcasts) and server-side builds +
 * publish + registry (artifact ZIP, cache, service lane).
 */

import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import JSZip from "jszip";
import { loadEnv, type Env } from "../src/env";
import { configureMongo, getDb, closeMongo } from "../src/mongodb";

const BASE = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3095";
const WS_BASE = BASE.replace(/^http/u, "ws");
const REDIRECT_URI = "http://127.0.0.1:53682/callback";
const SECOND_USER_ID = "900000000000000001";
const THIRD_USER_ID = "900000000000000002";
const SERVICE_TOKEN = process.env.ATELIER_SERVICE_TOKEN ?? "";
const SMOKE_PACK_NAME = "Smoke CAS Pack";
const SMOKE_LOCK_PACK_NAME = "Smoke Locks Pack";
const SMOKE_BUILD_PACK_NAME = "Smoke Build Pack";
const TEST_ASSET_SIZE = 20 * 1024 * 1024; // 20 MiB -> 3 chunks at 8 MiB

/** Deterministic 20 MiB pseudo-random payload (xorshift32) — same sha256 every run. */
function buildTestAsset(): Buffer {
  const buf = Buffer.allocUnsafe(TEST_ASSET_SIZE);
  let x = 0x4fee1900 >>> 0;
  for (let i = 0; i < TEST_ASSET_SIZE; i += 4) {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    buf.writeUInt32LE(x, i);
  }
  return buf;
}
const TEST_ASSET = buildTestAsset();
const TEST_ASSET_SHA = createHash("sha256").update(TEST_ASSET).digest("hex");
const UNKNOWN_SHA = "ab".repeat(32); // valid format, never uploaded

/** Remove the synthetic users so repeated smoke runs start clean. */
async function cleanupSyntheticUsers(): Promise<void> {
  try {
    const db = await getDb();
    const ids = [SECOND_USER_ID, THIRD_USER_ID];
    await db.collection("atelierUsers").deleteMany({ discordId: { $in: ids } });
    await db.collection("atelierDevices").deleteMany({ discordId: { $in: ids } });
    await db.collection("atelierAuthCodes").deleteMany({ discordId: { $in: ids } });
    await db.collection("atelierActivity").deleteMany({
      $or: [{ actorDiscordId: { $in: ids } }, { "data.discordId": { $in: ids } }],
    });
  } catch (e) {
    console.warn("  WARN  mongo cleanup skipped:", (e as Error).message);
  }
}

/**
 * Remove all CAS/pack fixtures of this script (deterministic test sha + pack
 * name) — runs at start AND end so crashed runs cannot poison the next one.
 */
async function cleanupCasFixtures(env: Env): Promise<void> {
  try {
    const db = await getDb();

    const uploads = await db
      .collection("atelierUploads")
      .find({ sha256Expected: TEST_ASSET_SHA })
      .toArray();
    for (const u of uploads) {
      if (typeof u.tmpPath === "string") await rm(u.tmpPath, { force: true }).catch(() => {});
    }
    await db.collection("atelierUploads").deleteMany({ sha256Expected: TEST_ASSET_SHA });
    await db.collection("atelierAssets").deleteMany({ sha256: TEST_ASSET_SHA });

    const packs = await db
      .collection("atelierPacks")
      .find({ name: { $in: [SMOKE_PACK_NAME, SMOKE_LOCK_PACK_NAME, SMOKE_BUILD_PACK_NAME] } })
      .toArray();
    const packIds = packs.map((p) => p.packId as string);
    if (packIds.length > 0) {
      await db.collection("atelierRevisions").deleteMany({ packId: { $in: packIds } });
      await db.collection("atelierLocks").deleteMany({ packId: { $in: packIds } });
      await db.collection("atelierWorkspaces").deleteMany({ packId: { $in: packIds } });
      await db.collection("atelierWorkspaceOperations").deleteMany({ packId: { $in: packIds } });
      await db.collection("atelierActivity").deleteMany({ "data.packId": { $in: packIds } });
      await db.collection("atelierBuilds").deleteMany({ packId: { $in: packIds } });
      await db.collection("atelierPacks").deleteMany({ packId: { $in: packIds } });
      // Build artifacts live at <storage>/builds/<packId>/ — drop the whole dirs.
      for (const packId of packIds) {
        await rm(resolve(env.ATELIER_STORAGE_ROOT, "builds", packId), {
          recursive: true,
          force: true,
        }).catch(() => {});
      }
    }

    await rm(
      resolve(env.ATELIER_STORAGE_ROOT, "cas", TEST_ASSET_SHA.slice(0, 2), `${TEST_ASSET_SHA}.ydd`),
      { force: true },
    ).catch(() => {});
  } catch (e) {
    console.warn("  WARN  CAS fixture cleanup skipped:", (e as Error).message);
  }
}

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}`, detail !== undefined ? JSON.stringify(detail) : "");
  }
}

async function getCodeViaFakeLogin(devId?: string, devUsername?: string): Promise<string> {
  const url = new URL(`${BASE}/api/v1/auth/discord/start`);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  if (devId) url.searchParams.set("dev_id", devId);
  if (devUsername) url.searchParams.set("dev_username", devUsername);
  const res = await fetch(url, { redirect: "manual" });
  const location = res.headers.get("location") ?? "";
  if (res.status !== 302 || !location.startsWith(REDIRECT_URI)) {
    throw new Error(`fake login failed: status=${res.status} location=${location} body=${await res.text()}`);
  }
  const code = new URL(location).searchParams.get("code") ?? "";
  if (!/^[0-9a-f]{32}$/u.test(code)) throw new Error(`unexpected code format: ${code}`);
  return code;
}

interface Tokens {
  accessToken: string;
  refreshToken: string;
  user: { discordId: string; username: string; status: string; role: string };
}

async function exchange(code: string, deviceName: string): Promise<{ status: number; body: Tokens }> {
  const res = await fetch(`${BASE}/api/v1/auth/device/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      redirect_uri: REDIRECT_URI,
      device: { name: deviceName, platform: "windows", appVersion: "0.1.0-smoke" },
    }),
  });
  return { status: res.status, body: (await res.json()) as Tokens };
}

async function api(path: string, token: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      authorization: `Bearer ${token}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {}
  return { status: res.status, body };
}

async function putChunk(uploadId: string, index: number, bytes: Uint8Array<ArrayBuffer>, token: string) {
  const res = await fetch(`${BASE}/api/v1/uploads/${uploadId}/chunks/${index}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
    body: bytes,
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {}
  return { status: res.status, body };
}

interface WsMsg {
  type: string;
  [key: string]: any;
}

/**
 * Tiny WebSocket test client: incoming messages are queued, waitFor()
 * consumes the first match (already queued or arriving later, null on timeout).
 */
class WsClient {
  private queue: WsMsg[] = [];
  private waiters: {
    pred: (m: WsMsg) => boolean;
    resolve: (m: WsMsg | null) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];

  private constructor(private ws: WebSocket) {
    ws.addEventListener("message", (ev) => {
      let msg: WsMsg | null = null;
      try {
        msg = JSON.parse(String(ev.data)) as WsMsg;
      } catch {}
      if (!msg || typeof msg.type !== "string") return;
      const idx = this.waiters.findIndex((w) => w.pred(msg!));
      if (idx >= 0) {
        const waiter = this.waiters.splice(idx, 1)[0]!;
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      } else {
        this.queue.push(msg);
      }
    });
  }

  /** Resolves after a successful upgrade; rejects when the server refuses it. */
  static connect(token: string): Promise<WsClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${WS_BASE}/api/v1/ws?token=${encodeURIComponent(token)}`);
      const client = new WsClient(ws);
      ws.addEventListener("open", () => resolve(client));
      ws.addEventListener("error", () => reject(new Error("ws upgrade failed")));
      ws.addEventListener("close", () => reject(new Error("ws closed before open")));
    });
  }

  send(msg: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  waitFor(pred: (m: WsMsg) => boolean, timeoutMs = 5000): Promise<WsMsg | null> {
    const idx = this.queue.findIndex(pred);
    if (idx >= 0) return Promise.resolve(this.queue.splice(idx, 1)[0]!);
    return new Promise((resolve) => {
      const waiter = {
        pred,
        resolve,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          resolve(null);
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {}
  }
}

/** True when the server refused the upgrade (e.g. invalid token). */
async function wsUpgradeRejected(token: string): Promise<boolean> {
  try {
    const client = await WsClient.connect(token);
    client.close();
    return false;
  } catch {
    return true;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function refresh(refreshToken: string) {
  const res = await fetch(`${BASE}/api/v1/auth/device/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {}
  return { status: res.status, body };
}

async function main() {
  console.log(`atelier-api smoke test against ${BASE}\n`);

  const env = loadEnv();
  configureMongo(env);
  await cleanupSyntheticUsers();
  await cleanupCasFixtures(env);

  // ---------------------------------------------------------------- health
  console.log("[1] health");
  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  check("GET /health ok", (health as any).ok === true && (health as any).service === "atelier-api", health);

  // ----------------------------------------------- redirect_uri validation
  console.log("[2] redirect_uri validation");
  const badRedirect = await fetch(
    `${BASE}/api/v1/auth/discord/start?redirect_uri=${encodeURIComponent("https://evil.example.com/cb")}`,
    { redirect: "manual" },
  );
  check("non-loopback redirect_uri rejected (400)", badRedirect.status === 400);

  // -------------------------------------------------- admin user (fake id)
  console.log("[3] admin fake login + exchange");
  const adminCode = await getCodeViaFakeLogin(); // default = ATELIER_DEV_FAKE_DISCORD_ID
  const adminEx = await exchange(adminCode, "Smoke Admin PC");
  check("exchange returns 200", adminEx.status === 200, adminEx.body);
  check("admin user approved+admin", adminEx.body.user?.status === "approved" && adminEx.body.user?.role === "admin", adminEx.body.user);
  check("refreshToken is 96 hex chars", /^[0-9a-f]{96}$/u.test(adminEx.body.refreshToken ?? ""));

  const reuse = await exchange(adminCode, "Smoke Admin PC again");
  check("one-time code cannot be reused", reuse.status === 400, reuse.body);

  const adminMe = await api("/api/v1/me", adminEx.body.accessToken);
  check("GET /me (admin) 200 + device", adminMe.status === 200 && adminMe.body?.device?.deviceId != null, adminMe.body);

  // --------------------------------------------------- second pending user
  console.log("[4] second user (pending gate)");
  const u2Code = await getCodeViaFakeLogin(SECOND_USER_ID, "SmokeUserZwei");
  const u2Ex = await exchange(u2Code, "Smoke User2 PC");
  check("user2 exchange 200", u2Ex.status === 200, u2Ex.body);
  check("user2 is pending member", u2Ex.body.user?.status === "pending" && u2Ex.body.user?.role === "member", u2Ex.body.user);

  const u2Me = await api("/api/v1/me", u2Ex.body.accessToken);
  check("GET /me works for pending user", u2Me.status === 200 && u2Me.body?.user?.status === "pending", u2Me.body);

  const u2Devices = await api("/api/v1/devices", u2Ex.body.accessToken);
  check("pending gate: /devices -> 403 pending_approval", u2Devices.status === 403 && u2Devices.body?.error === "pending_approval", u2Devices);

  // ----------------------------------------------------------- admin: list
  console.log("[5] admin endpoints");
  const pendingList = await api("/api/v1/admin/users?status=pending", adminEx.body.accessToken);
  const hasU2 = Array.isArray(pendingList.body?.users) && pendingList.body.users.some((u: any) => u.discordId === SECOND_USER_ID);
  check("GET /admin/users?status=pending contains user2", pendingList.status === 200 && hasU2, pendingList.body);

  const adminAsU2 = await api("/api/v1/admin/users", u2Ex.body.accessToken);
  check("admin route blocked for non-admin (403)", adminAsU2.status === 403, adminAsU2);

  const approve = await api(`/api/v1/admin/users/${SECOND_USER_ID}/approve`, adminEx.body.accessToken, { method: "POST" });
  check("approve user2 -> approved", approve.status === 200 && approve.body?.user?.status === "approved", approve.body);

  const u2DevicesAfter = await api("/api/v1/devices", u2Ex.body.accessToken);
  check("after approve: /devices 200 with same token", u2DevicesAfter.status === 200 && Array.isArray(u2DevicesAfter.body?.devices), u2DevicesAfter);

  // ------------------------------------ refresh rotation + replay detection
  console.log("[6] refresh rotation + replay detection");
  const oldRefresh = u2Ex.body.refreshToken;
  const rot1 = await refresh(oldRefresh);
  check("refresh with valid token -> 200 + new tokens", rot1.status === 200 && rot1.body?.refreshToken && rot1.body.refreshToken !== oldRefresh, rot1);

  const rot2 = await refresh(rot1.body.refreshToken);
  check("new refresh token works again", rot2.status === 200 && rot2.body?.refreshToken !== rot1.body.refreshToken, rot2);

  const meWithRotatedAccess = await api("/api/v1/me", rot2.body.accessToken);
  check("access token from refresh works", meWithRotatedAccess.status === 200);

  // Replaying the IMMEDIATELY previous token is detected as reuse and revokes
  // the whole device (token family) — rot2's tokens must die with it.
  const replay = await refresh(rot1.body.refreshToken);
  check("replayed (rotated-out) refresh token rejected (401)", replay.status === 401, replay);

  const familyRefreshDead = await refresh(rot2.body.refreshToken);
  check("replay detection revokes the family: newest refresh dead", familyRefreshDead.status === 401, familyRefreshDead);

  const familyAccessDead = await api("/api/v1/me", rot2.body.accessToken);
  check("replay detection revokes the family: access token dead", familyAccessDead.status === 401, familyAccessDead);

  // Tokens from older generations fail with a generic 401 (no family match).
  const ancient = await refresh(oldRefresh);
  check("ancient refresh token rejected (401)", ancient.status === 401, ancient);

  // Fresh session for the remaining sections (previous device was revoked).
  const u2bCode = await getCodeViaFakeLogin(SECOND_USER_ID, "SmokeUserZwei");
  const u2b = await exchange(u2bCode, "Smoke User2 PC (relogin)");
  check("re-login after replay revocation works", u2b.status === 200, u2b.body);

  // ------------------------------------------------------------ role change
  console.log("[7] role change");
  const promote = await api(`/api/v1/admin/users/${SECOND_USER_ID}/role`, adminEx.body.accessToken, {
    method: "POST",
    body: JSON.stringify({ role: "admin" }),
  });
  check("promote user2 to admin", promote.status === 200 && promote.body?.user?.role === "admin", promote.body);

  // role is re-read from DB on every request -> existing token gains access
  const u2AdminAccess = await api("/api/v1/admin/users", u2b.body.accessToken);
  check("user2 can use admin route after promote (DB re-read)", u2AdminAccess.status === 200, u2AdminAccess);

  const demote = await api(`/api/v1/admin/users/${SECOND_USER_ID}/role`, adminEx.body.accessToken, {
    method: "POST",
    body: JSON.stringify({ role: "member" }),
  });
  check("demote user2 back to member", demote.status === 200 && demote.body?.user?.role === "member", demote.body);

  // -------------------------------------------------------------- lock
  console.log("[8] lock revokes everything");
  const lock = await api(`/api/v1/admin/users/${SECOND_USER_ID}/lock`, adminEx.body.accessToken, { method: "POST" });
  check("lock user2 -> locked", lock.status === 200 && lock.body?.user?.status === "locked", lock.body);

  const u2AfterLock = await api("/api/v1/me", u2b.body.accessToken);
  check("locked user's access token invalid (401, device revoked)", u2AfterLock.status === 401, u2AfterLock);

  const u2RefreshAfterLock = await refresh(u2b.body.refreshToken);
  check("locked user's refresh rejected (401/403)", u2RefreshAfterLock.status === 401 || u2RefreshAfterLock.status === 403, u2RefreshAfterLock);

  // re-approve so the follow-up device tests work for user2
  await api(`/api/v1/admin/users/${SECOND_USER_ID}/approve`, adminEx.body.accessToken, { method: "POST" });

  // ------------------------------------------------------- device revoke
  console.log("[9] device list + revoke + logout");
  const u3Code = await getCodeViaFakeLogin(SECOND_USER_ID, "SmokeUserZwei");
  const u3Ex = await exchange(u3Code, "Smoke User2 Laptop");
  check("user2 second device exchange 200", u3Ex.status === 200, u3Ex.body);

  const u3List = await api("/api/v1/devices", u3Ex.body.accessToken);
  const laptop = u3List.body?.devices?.find((d: any) => d.current === true);
  check("device list contains current device", u3List.status === 200 && laptop != null, u3List.body);

  const delForeign = await api(`/api/v1/devices/00000000-0000-0000-0000-000000000000`, u3Ex.body.accessToken, { method: "DELETE" });
  check("deleting unknown device -> 404", delForeign.status === 404, delForeign);

  const logout = await api("/api/v1/auth/device/logout", u3Ex.body.accessToken, { method: "POST" });
  check("logout 200", logout.status === 200, logout);
  const afterLogout = await api("/api/v1/me", u3Ex.body.accessToken);
  check("access token dead after logout (401)", afterLogout.status === 401, afterLogout);

  // ------------------------------------------------------- service token
  console.log("[10] service token");
  const noToken = await fetch(`${BASE}/api/v1/internal/ping`);
  check("internal ping without token -> 401", noToken.status === 401);
  if (SERVICE_TOKEN) {
    const withToken = await fetch(`${BASE}/api/v1/internal/ping`, {
      headers: { "x-fg-service-token": SERVICE_TOKEN },
    });
    check("internal ping with token -> 200", withToken.status === 200);
  } else {
    console.log("  SKIP  internal ping with token (ATELIER_SERVICE_TOKEN not in env)");
  }

  // ------------------------------------------- CAS uploads + packs + revisions
  console.log("[11] CAS uploads + packs + revisions");
  const adminTok = adminEx.body.accessToken;

  const init1 = await api("/api/v1/uploads", adminTok, {
    method: "POST",
    body: JSON.stringify({ sha256: TEST_ASSET_SHA, size: TEST_ASSET_SIZE, kind: "ydd" }),
  });
  check("upload init 200 with server-fixed chunkSize", init1.status === 200 && typeof init1.body?.uploadId === "string" && init1.body?.chunkSize > 0, init1.body);
  const uploadId: string = init1.body.uploadId;
  const chunkSize: number = init1.body.chunkSize;
  const totalChunks: number = init1.body.totalChunks;
  check("totalChunks matches ceil(size/chunkSize)", totalChunks === Math.ceil(TEST_ASSET_SIZE / chunkSize), init1.body);

  const chunkAt = (i: number) =>
    new Uint8Array(TEST_ASSET.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, TEST_ASSET_SIZE)));

  // Out-of-order: last chunk first, then chunk 0.
  const putLast = await putChunk(uploadId, totalChunks - 1, chunkAt(totalChunks - 1), adminTok);
  check("PUT last chunk (out of order) 200", putLast.status === 200 && Array.isArray(putLast.body?.receivedChunks), putLast.body);
  const put0 = await putChunk(uploadId, 0, chunkAt(0), adminTok);
  check("PUT chunk 0 200", put0.status === 200, put0.body);

  const putBad = await putChunk(uploadId, 1, chunkAt(1).slice(0, 1000), adminTok);
  check("wrong-size chunk body -> 409", putBad.status === 409, putBad);

  // Resume: re-init returns the SAME open session including received chunks.
  const init2 = await api("/api/v1/uploads", adminTok, {
    method: "POST",
    body: JSON.stringify({ sha256: TEST_ASSET_SHA, size: TEST_ASSET_SIZE, kind: "ydd" }),
  });
  check("re-init resumes same session", init2.status === 200 && init2.body?.uploadId === uploadId, init2.body);
  check(
    "resumed session lists received chunks",
    Array.isArray(init2.body?.receivedChunks) &&
      init2.body.receivedChunks.includes(0) &&
      init2.body.receivedChunks.includes(totalChunks - 1) &&
      !init2.body.receivedChunks.includes(1),
    init2.body,
  );

  const status1 = await api(`/api/v1/uploads/${uploadId}`, adminTok);
  check("GET upload status (open, 2 chunks)", status1.status === 200 && status1.body?.status === "open" && status1.body?.receivedChunks?.length === 2, status1.body);

  const earlyComplete = await api(`/api/v1/uploads/${uploadId}/complete`, adminTok, { method: "POST" });
  check("complete with missing chunks -> 409", earlyComplete.status === 409, earlyComplete);

  for (let i = 1; i < totalChunks - 1; i++) {
    await putChunk(uploadId, i, chunkAt(i), adminTok);
  }
  const complete = await api(`/api/v1/uploads/${uploadId}/complete`, adminTok, { method: "POST" });
  check("complete 200 + sha", complete.status === 200 && complete.body?.ok === true && complete.body?.sha256 === TEST_ASSET_SHA, complete.body);

  const checkRes = await api("/api/v1/assets/check", adminTok, {
    method: "POST",
    body: JSON.stringify({
      files: [
        { sha256: TEST_ASSET_SHA, size: TEST_ASSET_SIZE, kind: "ydd" },
        { sha256: UNKNOWN_SHA, size: 1, kind: "ydd" },
      ],
    }),
  });
  check(
    "/assets/check shows present + missing",
    checkRes.status === 200 && checkRes.body?.present?.includes(TEST_ASSET_SHA) && checkRes.body?.missing?.includes(UNKNOWN_SHA),
    checkRes.body,
  );

  const init3 = await api("/api/v1/uploads", adminTok, {
    method: "POST",
    body: JSON.stringify({ sha256: TEST_ASSET_SHA, size: TEST_ASSET_SIZE, kind: "ydd" }),
  });
  check("upload init for existing asset -> 409 already_exists", init3.status === 409 && init3.body?.error === "already_exists", init3);

  const fullRes = await fetch(`${BASE}/api/v1/assets/${TEST_ASSET_SHA}`, {
    headers: { authorization: `Bearer ${adminTok}` },
  });
  const fullBuf = Buffer.from(await fullRes.arrayBuffer());
  check("GET asset full 200 + ETag", fullRes.status === 200 && fullRes.headers.get("etag") === `"${TEST_ASSET_SHA}"`, fullRes.status);
  check("downloaded bytes hash-verify", createHash("sha256").update(fullBuf).digest("hex") === TEST_ASSET_SHA);

  const rangeRes = await fetch(`${BASE}/api/v1/assets/${TEST_ASSET_SHA}`, {
    headers: { authorization: `Bearer ${adminTok}`, range: "bytes=0-1023" },
  });
  const rangeBuf = Buffer.from(await rangeRes.arrayBuffer());
  check(
    "ranged GET -> 206 with 1024 bytes",
    rangeRes.status === 206 && rangeBuf.byteLength === 1024 && rangeRes.headers.get("content-range") === `bytes 0-1023/${TEST_ASSET_SIZE}`,
    { status: rangeRes.status, len: rangeBuf.byteLength },
  );
  check("ranged bytes match source", rangeBuf.equals(TEST_ASSET.subarray(0, 1024)));

  const cachedRes = await fetch(`${BASE}/api/v1/assets/${TEST_ASSET_SHA}`, {
    headers: { authorization: `Bearer ${adminTok}`, "if-none-match": `"${TEST_ASSET_SHA}"` },
  });
  check("If-None-Match -> 304", cachedRes.status === 304, cachedRes.status);

  const badSha = await api("/api/v1/assets/zzzz", adminTok);
  check("bad sha -> 400/404", badSha.status === 400 || badSha.status === 404, badSha);

  // --- packs + revisions ------------------------------------------------
  const viewerCode = await getCodeViaFakeLogin(SECOND_USER_ID, "SmokeUserZwei");
  const viewerEx = await exchange(viewerCode, "Smoke Viewer PC");
  check("viewer (user2) login 200", viewerEx.status === 200, viewerEx.body);
  const viewerTok = viewerEx.body.accessToken;

  const packRes = await api("/api/v1/packs", adminTok, {
    method: "POST",
    body: JSON.stringify({ name: SMOKE_PACK_NAME, description: "Smoke-Test Pack" }),
  });
  check("create pack 200 (headRevision 0 + slug)", packRes.status === 200 && packRes.body?.pack?.headRevision === 0 && typeof packRes.body?.pack?.slug === "string", packRes.body);
  const packId: string = packRes.body.pack.packId;

  const noHead = await api(`/api/v1/packs/${packId}/revisions/head/manifest`, adminTok);
  check("manifest head with 0 revisions -> 404", noHead.status === 404, noHead);

  // Team-wide access: user2 is approved but NOT a member of this pack here, so
  // these prove the pure team default (every approved user reaches any pack).
  const foreignGet = await api(`/api/v1/packs/${packId}`, viewerTok);
  check("approved non-member GET pack -> 200 (team access)", foreignGet.status === 200, foreignGet);

  const teamList = await api("/api/v1/packs", viewerTok);
  check(
    "approved non-member sees owner's pack in list",
    teamList.status === 200 && teamList.body?.packs?.some((p: any) => p.packId === packId),
    teamList.body,
  );

  const teamGet2 = await api(`/api/v1/packs/${packId}`, viewerTok);
  check("approved non-member GET pack -> 200", teamGet2.status === 200, teamGet2);

  const addMember = await api(`/api/v1/packs/${packId}/members`, adminTok, {
    method: "POST",
    body: JSON.stringify({ discordId: SECOND_USER_ID, role: "viewer" }),
  });
  check(
    "add viewer member 200",
    addMember.status === 200 && addMember.body?.pack?.members?.some((m: any) => m.discordId === SECOND_USER_ID && m.role === "viewer"),
    addMember.body,
  );

  const viewerPacks = await api("/api/v1/packs", viewerTok);
  check("team user (now viewer member) sees pack in list", viewerPacks.status === 200 && viewerPacks.body?.packs?.some((p: any) => p.packId === packId), viewerPacks.body);

  const drawable = {
    id: randomUUID(),
    gender: "male",
    kind: "component",
    type: "jbib",
    mode: "addon",
    replaceTargetId: null,
    label: "Smoke Jacket",
    groupId: null,
    ydd: { sha256: TEST_ASSET_SHA, size: TEST_ASSET_SIZE, exportName: "smoke_jacket.ydd" },
    textures: [],
    physics: null,
    firstPerson: null,
    flags: { highHeels: false, hairScaleValue: null },
  };

  const viewerRev = await api(`/api/v1/packs/${packId}/revisions`, viewerTok, {
    method: "POST",
    body: JSON.stringify({ baseRevision: 0, message: "viewer try", drawables: [drawable] }),
  });
  check("viewer POST revision -> 403", viewerRev.status === 403, viewerRev);

  const missingRev = await api(`/api/v1/packs/${packId}/revisions`, adminTok, {
    method: "POST",
    body: JSON.stringify({
      baseRevision: 0,
      message: "missing asset",
      drawables: [{ ...drawable, ydd: { sha256: UNKNOWN_SHA, size: 1, exportName: "missing.ydd" } }],
    }),
  });
  check(
    "revision with unknown asset -> 400 missing_assets",
    missingRev.status === 400 && missingRev.body?.error === "missing_assets" && missingRev.body?.missing?.includes(UNKNOWN_SHA),
    missingRev.body,
  );

  const rev1 = await api(`/api/v1/packs/${packId}/revisions`, adminTok, {
    method: "POST",
    body: JSON.stringify({ baseRevision: 0, message: "Erste Version", drawables: [drawable] }),
  });
  check("POST revision 1 -> 200", rev1.status === 200 && rev1.body?.revision?.revision === 1 && rev1.body?.revision?.stats?.drawableCount === 1, rev1.body);

  const stale = await api(`/api/v1/packs/${packId}/revisions`, adminTok, {
    method: "POST",
    body: JSON.stringify({ baseRevision: 0, message: "stale base", drawables: [drawable] }),
  });
  check("stale baseRevision -> 409 head_changed + head doc", stale.status === 409 && stale.body?.error === "head_changed" && stale.body?.head?.revision === 1, stale.body);

  const headManifest = await api(`/api/v1/packs/${packId}/revisions/head/manifest`, adminTok);
  check(
    "GET manifest head -> revision 1 with drawable",
    headManifest.status === 200 && headManifest.body?.revision?.revision === 1 && headManifest.body?.revision?.drawables?.length === 1,
    headManifest.body,
  );

  // Team user pulls the head manifest + a referenced asset (the clone flow on
  // the desktop relies on both). viewerTok has at least read access.
  const teamHead = await api(`/api/v1/packs/${packId}/revisions/head/manifest`, viewerTok);
  check(
    "team user GET head manifest -> 200",
    teamHead.status === 200 && teamHead.body?.revision?.revision === 1,
    teamHead.body,
  );
  const teamDl = await fetch(`${BASE}/api/v1/assets/${TEST_ASSET_SHA}`, {
    headers: { authorization: `Bearer ${viewerTok}` },
  });
  check("team user downloads referenced asset -> 200", teamDl.status === 200, teamDl.status);

  const viewerRevList = await api(`/api/v1/packs/${packId}/revisions`, viewerTok);
  check(
    "viewer GET revisions 200 (meta only)",
    viewerRevList.status === 200 && viewerRevList.body?.revisions?.length === 1 && viewerRevList.body.revisions[0]?.drawables === undefined,
    viewerRevList.body,
  );

  const archive = await api(`/api/v1/packs/${packId}`, adminTok, { method: "DELETE" });
  check("archive pack 200", archive.status === 200, archive);

  const afterArchive = await api(`/api/v1/packs/${packId}/revisions`, adminTok);
  check("archived pack revisions -> 404", afterArchive.status === 404, afterArchive);

  // ------------------------------------------------ locks + websocket collab
  console.log("[12] locks + websocket collab");
  const editor2Tok = viewerTok; // user2 becomes EDITOR in the lock pack below

  // Third synthetic user -> approved viewer.
  const u3LockCode = await getCodeViaFakeLogin(THIRD_USER_ID, "SmokeUserDrei");
  const u3LockEx = await exchange(u3LockCode, "Smoke User3 PC");
  check("user3 login 200", u3LockEx.status === 200, u3LockEx.body);
  const approveU3 = await api(`/api/v1/admin/users/${THIRD_USER_ID}/approve`, adminTok, { method: "POST" });
  check("approve user3 200", approveU3.status === 200, approveU3.body);
  const viewer3Tok = u3LockEx.body.accessToken;

  const lockPackRes = await api("/api/v1/packs", adminTok, {
    method: "POST",
    body: JSON.stringify({ name: SMOKE_LOCK_PACK_NAME, description: "Smoke-Test Locks" }),
  });
  check("create lock pack 200", lockPackRes.status === 200, lockPackRes.body);
  const lockPackId: string = lockPackRes.body.pack.packId;
  await api(`/api/v1/packs/${lockPackId}/members`, adminTok, {
    method: "POST",
    body: JSON.stringify({ discordId: SECOND_USER_ID, role: "editor" }),
  });
  await api(`/api/v1/packs/${lockPackId}/members`, adminTok, {
    method: "POST",
    body: JSON.stringify({ discordId: THIRD_USER_ID, role: "viewer" }),
  });

  // --- lock REST ---------------------------------------------------------
  const entryId = randomUUID();
  const acq1 = await api(`/api/v1/packs/${lockPackId}/locks`, editor2Tok, {
    method: "POST",
    body: JSON.stringify({ drawableEntryId: entryId }),
  });
  check(
    "editor acquires lock 200",
    acq1.status === 200 && acq1.body?.lock?.lockedByDiscordId === SECOND_USER_ID && typeof acq1.body?.lock?.expiresAt === "string",
    acq1.body,
  );

  const acq2 = await api(`/api/v1/packs/${lockPackId}/locks`, adminTok, {
    method: "POST",
    body: JSON.stringify({ drawableEntryId: entryId }),
  });
  check(
    "second user acquire -> 409 locked + holder info",
    acq2.status === 409 && acq2.body?.error === "locked" && acq2.body?.lock?.lockedByDiscordId === SECOND_USER_ID,
    acq2.body,
  );

  await sleep(25); // ensure the heartbeat lands on a later timestamp
  const hb = await api(`/api/v1/packs/${lockPackId}/locks/${entryId}/heartbeat`, editor2Tok, { method: "PUT" });
  check(
    "heartbeat extends expiresAt",
    hb.status === 200 && new Date(hb.body?.lock?.expiresAt).getTime() > new Date(acq1.body.lock.expiresAt).getTime(),
    hb.body,
  );

  const hbForeign = await api(`/api/v1/packs/${lockPackId}/locks/${entryId}/heartbeat`, adminTok, { method: "PUT" });
  check("foreign heartbeat -> 404", hbForeign.status === 404, hbForeign);

  const viewerLock = await api(`/api/v1/packs/${lockPackId}/locks`, viewer3Tok, {
    method: "POST",
    body: JSON.stringify({ drawableEntryId: randomUUID() }),
  });
  check("viewer POST lock -> 403", viewerLock.status === 403, viewerLock);

  const delNoForce = await api(`/api/v1/packs/${lockPackId}/locks/${entryId}`, adminTok, { method: "DELETE" });
  check("foreign release without force -> 409 locked", delNoForce.status === 409 && delNoForce.body?.error === "locked", delNoForce);

  const forceDel = await api(`/api/v1/packs/${lockPackId}/locks/${entryId}?force=1`, adminTok, { method: "DELETE" });
  check("force-break by other editor 200", forceDel.status === 200 && forceDel.body?.ok === true, forceDel);

  // logActivity is fire-and-forget — poll briefly for the audit doc.
  let brokenLogged = false;
  for (let i = 0; i < 10 && !brokenLogged; i++) {
    const db = await getDb();
    brokenLogged =
      (await db.collection("atelierActivity").findOne({
        type: "lock.broken",
        "data.packId": lockPackId,
        "data.drawableEntryId": entryId,
      })) != null;
    if (!brokenLogged) await sleep(100);
  }
  check("lock.broken activity logged", brokenLogged);

  const acq3 = await api(`/api/v1/packs/${lockPackId}/locks`, editor2Tok, {
    method: "POST",
    body: JSON.stringify({ drawableEntryId: entryId }),
  });
  check("re-acquire after force-break 200", acq3.status === 200 && acq3.body?.lock?.lockedByDiscordId === SECOND_USER_ID, acq3.body);
  const ownRelease = await api(`/api/v1/packs/${lockPackId}/locks/${entryId}`, editor2Tok, { method: "DELETE" });
  check("own release 200", ownRelease.status === 200 && ownRelease.body?.ok === true, ownRelease);

  // --- websocket ----------------------------------------------------------
  check("ws upgrade with invalid token rejected", await wsUpgradeRejected("not-a-jwt"));

  const wsA = await WsClient.connect(adminTok); // admin
  wsA.send({ type: "join", packId: lockPackId });
  const joinedA = await wsA.waitFor((m) => m.type === "joined" && m.packId === lockPackId);
  check(
    "client A joined + roster has self",
    joinedA != null && joinedA.roster?.some((u: any) => u.discordId === adminEx.body.user.discordId),
    joinedA,
  );

  const wsB = await WsClient.connect(editor2Tok); // user2 (editor)
  wsB.send({ type: "join", packId: lockPackId });
  const joinedB = await wsB.waitFor((m) => m.type === "joined" && m.packId === lockPackId);
  check("client B joined, roster lists both users", joinedB != null && joinedB.roster?.length === 2, joinedB);
  const presJoin = await wsA.waitFor((m) => m.type === "presence" && m.event === "join");
  check("A receives presence join for B", presJoin != null && presJoin.user?.discordId === SECOND_USER_ID, presJoin);

  wsA.send({ type: "ping" });
  check("ping -> pong", (await wsA.waitFor((m) => m.type === "pong")) != null);

  // REST lock acquire broadcasts into the room.
  const wsEntryId = randomUUID();
  const acqWs = await api(`/api/v1/packs/${lockPackId}/locks`, editor2Tok, {
    method: "POST",
    body: JSON.stringify({ drawableEntryId: wsEntryId }),
  });
  check("editor acquires ws lock 200", acqWs.status === 200, acqWs.body);
  const lockMsgA = await wsA.waitFor((m) => m.type === "lock" && m.event === "acquired" && m.lock?.drawableEntryId === wsEntryId);
  const lockMsgB = await wsB.waitFor((m) => m.type === "lock" && m.event === "acquired" && m.lock?.drawableEntryId === wsEntryId);
  check(
    "lock acquired broadcast to both clients",
    lockMsgA != null && lockMsgB != null && lockMsgA.lock?.lockedByDiscordId === SECOND_USER_ID,
    lockMsgA,
  );

  // head-changed after a successful revision POST.
  const wsRev = await api(`/api/v1/packs/${lockPackId}/revisions`, adminTok, {
    method: "POST",
    body: JSON.stringify({ baseRevision: 0, message: "WS Smoke Revision", drawables: [drawable] }),
  });
  check("revision POST on lock pack 200", wsRev.status === 200 && wsRev.body?.revision?.revision === 1, wsRev.body);
  const headA = await wsA.waitFor((m) => m.type === "head-changed");
  const headB = await wsB.waitFor((m) => m.type === "head-changed");
  check(
    "head-changed broadcast to both clients",
    headA?.revision === 1 && headA?.byDiscordId === adminEx.body.user.discordId && headB?.revision === 1,
    headA,
  );

  // --- durable live workspace -------------------------------------------
  const workspaceProject = {
    id: randomUUID(),
    name: "Smoke Live Workspace",
    createdAt: new Date().toISOString(),
    settings: { dlcName: "smoke_live", defaultGender: "male" },
    groups: [],
    drawables: [drawable],
    tattooCollection: { name: "smoke_live", label: "Tattoos" },
    tattoos: [],
  };
  const viewerInit = await api(
    `/api/v1/packs/${lockPackId}/workspace/initialize`,
    viewer3Tok,
    {
      method: "POST",
      body: JSON.stringify({ baseRevision: 1, project: workspaceProject }),
    },
  );
  check("viewer cannot initialize live workspace (403)", viewerInit.status === 403, viewerInit);

  const workspaceInit = await api(
    `/api/v1/packs/${lockPackId}/workspace/initialize`,
    adminTok,
    {
      method: "POST",
      body: JSON.stringify({ baseRevision: 1, project: workspaceProject }),
    },
  );
  check(
    "initialize durable live workspace -> version 0",
    workspaceInit.status === 201 && workspaceInit.body?.workspace?.version === 0,
    workspaceInit.body,
  );
  const resetA = await wsA.waitFor((m) => m.type === "workspace-reset");
  const resetB = await wsB.waitFor((m) => m.type === "workspace-reset");
  check("workspace initialization broadcasts reset", resetA?.version === 0 && resetB?.version === 0);

  const operationId = randomUUID();
  const livePatch = {
    operationId,
    baseVersion: 0,
    operation: {
      kind: "entity.patch",
      entityType: "drawable",
      id: drawable.id,
      patch: { label: "Smoke Jacket Live" },
    },
  };
  const operationResult = await api(
    `/api/v1/packs/${lockPackId}/workspace/operations`,
    editor2Tok,
    { method: "POST", body: JSON.stringify(livePatch) },
  );
  check(
    "editor live operation commits atomically -> version 1",
    operationResult.status === 200 && operationResult.body?.version === 1,
    operationResult.body,
  );
  const changedA = await wsA.waitFor(
    (m) => m.type === "workspace-changed" && m.operationId === operationId,
  );
  const changedB = await wsB.waitFor(
    (m) => m.type === "workspace-changed" && m.operationId === operationId,
  );
  check(
    "accepted operation broadcasts exact version to both clients",
    changedA?.version === 1 && changedB?.version === 1,
    changedA,
  );

  const duplicateResult = await api(
    `/api/v1/packs/${lockPackId}/workspace/operations`,
    editor2Tok,
    { method: "POST", body: JSON.stringify(livePatch) },
  );
  check(
    "operation retry is idempotent",
    duplicateResult.status === 200 && duplicateResult.body?.duplicate === true,
    duplicateResult.body,
  );
  const workspaceRead = await api(`/api/v1/packs/${lockPackId}/workspace`, viewer3Tok);
  check(
    "viewer reads authoritative live snapshot without a duplicate version bump",
    workspaceRead.status === 200 &&
      workspaceRead.body?.workspace?.version === 1 &&
      workspaceRead.body?.workspace?.project?.drawables?.[0]?.label === "Smoke Jacket Live",
    workspaceRead.body,
  );

  const liveLock = await api(`/api/v1/packs/${lockPackId}/locks`, adminTok, {
    method: "POST",
    body: JSON.stringify({ drawableEntryId: drawable.id }),
  });
  check("admin locks live drawable", liveLock.status === 200, liveLock.body);
  const lockedOperation = await api(
    `/api/v1/packs/${lockPackId}/workspace/operations`,
    editor2Tok,
    {
      method: "POST",
      body: JSON.stringify({
        operationId: randomUUID(),
        baseVersion: 1,
        operation: {
          kind: "entity.patch",
          entityType: "drawable",
          id: drawable.id,
          patch: { label: "Must be rejected" },
        },
      }),
    },
  );
  check(
    "foreign lock rejects live mutation without advancing the version",
    lockedOperation.status === 409 && lockedOperation.body?.error === "locked",
    lockedOperation.body,
  );
  await api(`/api/v1/packs/${lockPackId}/locks/${drawable.id}`, adminTok, {
    method: "DELETE",
  });

  // Viewer joins read-only via WS (lock POST stays 403, checked above).
  const wsV = await WsClient.connect(viewer3Tok);
  wsV.send({ type: "join", packId: lockPackId });
  const joinedV = await wsV.waitFor((m) => m.type === "joined" && m.packId === lockPackId);
  check(
    "viewer ws join reports current workspace version",
    joinedV?.workspaceVersion === 1,
    joinedV,
  );

  // Disconnect B: presence leave + auto-release of B's locks must broadcast.
  wsB.close();
  const releasedMsg = await wsA.waitFor((m) => m.type === "lock" && m.event === "released" && m.lock?.drawableEntryId === wsEntryId);
  check(
    "locks auto-released on disconnect (broadcast)",
    releasedMsg != null && releasedMsg.lock?.lockedByDiscordId === SECOND_USER_ID,
    releasedMsg,
  );
  const presLeave = await wsA.waitFor((m) => m.type === "presence" && m.event === "leave" && m.user?.discordId === SECOND_USER_ID);
  check("A receives presence leave for B", presLeave != null, presLeave);

  const acqAfter = await api(`/api/v1/packs/${lockPackId}/locks`, adminTok, {
    method: "POST",
    body: JSON.stringify({ drawableEntryId: wsEntryId }),
  });
  check(
    "lock acquirable after auto-release",
    acqAfter.status === 200 && acqAfter.body?.lock?.lockedByDiscordId === adminEx.body.user.discordId,
    acqAfter.body,
  );

  wsA.close();
  wsV.close();
  await api(`/api/v1/packs/${lockPackId}`, adminTok, { method: "DELETE" });

  // ----------------------------------------- builds + publish + registry
  console.log("[13] builds + publish + registry");

  const serviceApi = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { ...(init?.headers ?? {}), "x-fg-service-token": SERVICE_TOKEN },
    });
    let body: any = null;
    try {
      body = await res.json();
    } catch {}
    return { status: res.status, body };
  };

  const buildPackRes = await api("/api/v1/packs", adminTok, {
    method: "POST",
    body: JSON.stringify({ name: SMOKE_BUILD_PACK_NAME, description: "Smoke-Test Builds" }),
  });
  check("create build pack 200", buildPackRes.status === 200, buildPackRes.body);
  const buildPackId: string = buildPackRes.body.pack.packId;
  const buildPackSlug: string = buildPackRes.body.pack.slug;
  await api(`/api/v1/packs/${buildPackId}/members`, adminTok, {
    method: "POST",
    body: JSON.stringify({ discordId: SECOND_USER_ID, role: "viewer" }),
  });

  const buildNoRev = await api(`/api/v1/packs/${buildPackId}/builds`, adminTok, {
    method: "POST",
    body: JSON.stringify({ revision: "head" }),
  });
  check("build head with 0 revisions -> 404", buildNoRev.status === 404, buildNoRev);

  const buildDrawable = {
    ...drawable,
    id: randomUUID(),
    label: "Smoke Build Jacket",
    textures: [{ sha256: TEST_ASSET_SHA, size: TEST_ASSET_SIZE, exportName: "smoke_tex.ytd" }],
  };
  const buildRev = await api(`/api/v1/packs/${buildPackId}/revisions`, adminTok, {
    method: "POST",
    body: JSON.stringify({ baseRevision: 0, message: "Build-Revision", drawables: [buildDrawable] }),
  });
  check("build pack revision 1 created", buildRev.status === 200 && buildRev.body?.revision?.revision === 1, buildRev.body);

  const viewerBuild = await api(`/api/v1/packs/${buildPackId}/builds`, viewerTok, {
    method: "POST",
    body: JSON.stringify({ revision: "head" }),
  });
  check("viewer cannot build (403)", viewerBuild.status === 403, viewerBuild);

  const buildStart = await api(`/api/v1/packs/${buildPackId}/builds`, adminTok, {
    method: "POST",
    body: JSON.stringify({ revision: "head" }),
  });
  check(
    "build head -> 202 queued/running",
    buildStart.status === 202 && ["queued", "running"].includes(buildStart.body?.build?.status) && typeof buildStart.body?.build?.buildId === "string",
    buildStart.body,
  );
  const buildId: string = buildStart.body.build.buildId;

  let buildFinal: any = null;
  for (let i = 0; i < 60; i++) {
    const st = await api(`/api/v1/builds/${buildId}`, adminTok);
    if (st.body?.build?.status === "done" || st.body?.build?.status === "error") {
      buildFinal = st.body.build;
      break;
    }
    await sleep(500);
  }
  check("build finishes with status done", buildFinal?.status === "done" && buildFinal?.sizeBytes > 0, buildFinal);
  check(
    "build report lists 1 resource with 1 drawable",
    buildFinal?.report?.resources?.length === 1 && buildFinal.report.resources[0]?.drawables === 1,
    buildFinal?.report,
  );

  const viewerStatus = await api(`/api/v1/builds/${buildId}`, viewerTok);
  check("viewer (member) can read build status", viewerStatus.status === 200 && viewerStatus.body?.build?.status === "done", viewerStatus);

  const artifactRes = await fetch(`${BASE}/api/v1/builds/${buildId}/artifact`, {
    headers: { authorization: `Bearer ${adminTok}` },
  });
  const artifactBuf = Buffer.from(await artifactRes.arrayBuffer());
  check(
    "artifact downloads as ZIP",
    artifactRes.status === 200 &&
      artifactRes.headers.get("content-type") === "application/zip" &&
      artifactBuf.subarray(0, 2).toString("latin1") === "PK",
    { status: artifactRes.status, len: artifactBuf.byteLength },
  );

  const zip = await JSZip.loadAsync(artifactBuf);
  const zipNames = Object.keys(zip.files);
  const dlc = buildPackSlug.replace(/[^a-zA-Z0-9_]/gu, "_").toLowerCase();
  const expectedYdd = `${buildPackSlug}/stream/mp_m_freemode_01_${dlc}^jbib_000_u.ydd`;
  const expectedYtd = `${buildPackSlug}/stream/mp_m_freemode_01_${dlc}^jbib_diff_000_a_uni.ytd`;
  check("ZIP contains fxmanifest.lua", zipNames.includes(`${buildPackSlug}/fxmanifest.lua`), zipNames);
  check("ZIP contains canonical stream YDD", zipNames.includes(expectedYdd), zipNames);
  check("ZIP contains canonical stream YTD (diff a)", zipNames.includes(expectedYtd), zipNames);
  check("ZIP contains shop_ped_apparel.meta", zipNames.includes(`${buildPackSlug}/stream/shop_ped_apparel.meta`), zipNames);
  check("ZIP contains ATELIER_README.txt (YMT-Hinweis)", zipNames.includes(`${buildPackSlug}/stream/ATELIER_README.txt`), zipNames);
  const buildJsonRaw = await zip.file(`${buildPackSlug}/atelier-build.json`)?.async("string");
  const buildJson = buildJsonRaw ? JSON.parse(buildJsonRaw) : null;
  check(
    "atelier-build.json marks missing server YMTs",
    buildJson?.ymt === "missing-server-build" && buildJson?.tool === "atelier by feelgood" && buildJson?.target === "fivem",
    buildJson,
  );

  const buildAgain = await api(`/api/v1/packs/${buildPackId}/builds`, adminTok, {
    method: "POST",
    body: JSON.stringify({ revision: 1 }),
  });
  check(
    "second build of same revision -> 200 done (cache)",
    buildAgain.status === 200 && buildAgain.body?.build?.status === "done" && buildAgain.body?.build?.buildId === buildId,
    buildAgain.body,
  );

  // --- publish + registry --------------------------------------------------
  const foreignPublish = await api(`/api/v1/packs/${buildPackId}/publish`, viewerTok, {
    method: "POST",
    body: JSON.stringify({ visibility: "community", targets: ["hub"], revision: 1 }),
  });
  check("publish by non-owner -> 403", foreignPublish.status === 403, foreignPublish);

  const regBefore = await serviceApi(`/api/v1/registry/packs?q=${encodeURIComponent(SMOKE_BUILD_PACK_NAME)}`);
  check(
    "unpublished pack NOT in registry",
    regBefore.status === 200 && !regBefore.body?.packs?.some((p: any) => p.packId === buildPackId),
    regBefore.body,
  );

  const publish = await api(`/api/v1/packs/${buildPackId}/publish`, adminTok, {
    method: "POST",
    body: JSON.stringify({ visibility: "community", targets: ["hub"], revision: 1 }),
  });
  check(
    "publish 200 + publish state on pack",
    publish.status === 200 &&
      publish.body?.pack?.publish?.visibility === "community" &&
      publish.body?.pack?.publish?.publishedRevision === 1 &&
      publish.body?.pack?.publish?.targets?.includes("hub"),
    publish.body,
  );

  const regNoToken = await fetch(`${BASE}/api/v1/registry/packs`);
  check("registry without service token -> 401", regNoToken.status === 401);

  const regList = await serviceApi(`/api/v1/registry/packs?target=hub&q=${encodeURIComponent("smoke build")}`);
  const regEntry = regList.body?.packs?.find((p: any) => p.packId === buildPackId);
  check(
    "registry lists published pack (target=hub)",
    regList.status === 200 && regEntry?.publishedRevision === 1 && regEntry?.drawableCount === 1 && regList.body?.total >= 1,
    regList.body,
  );

  const regWrongTarget = await serviceApi(`/api/v1/registry/packs?target=webseite&q=${encodeURIComponent("smoke build")}`);
  check(
    "registry filters by target (webseite empty)",
    regWrongTarget.status === 200 && !regWrongTarget.body?.packs?.some((p: any) => p.packId === buildPackId),
    regWrongTarget.body,
  );

  const regDetail = await serviceApi(`/api/v1/registry/packs/${buildPackSlug}`);
  check(
    "registry detail by slug -> pack + revision manifest",
    regDetail.status === 200 &&
      regDetail.body?.pack?.packId === buildPackId &&
      regDetail.body?.revision?.revision === 1 &&
      regDetail.body?.revision?.drawables?.length === 1,
    regDetail.body,
  );

  const regDownload = await fetch(`${BASE}/api/v1/registry/packs/${buildPackSlug}/download`, {
    headers: { "x-fg-service-token": SERVICE_TOKEN },
  });
  const regZipBuf = Buffer.from(await regDownload.arrayBuffer());
  check(
    "registry download streams the cached build ZIP",
    regDownload.status === 200 && regZipBuf.subarray(0, 2).toString("latin1") === "PK" && regZipBuf.byteLength === artifactBuf.byteLength,
    { status: regDownload.status, len: regZipBuf.byteLength },
  );

  // --- self-clean: delist, archive, drop artifacts ------------------------
  const delist = await api(`/api/v1/packs/${buildPackId}/publish`, adminTok, {
    method: "POST",
    body: JSON.stringify({ visibility: "private", targets: [], revision: 1 }),
  });
  check("re-publish as private delists", delist.status === 200 && delist.body?.pack?.publish?.visibility === "private", delist.body);
  const regAfterDelist = await serviceApi(`/api/v1/registry/packs/${buildPackSlug}`);
  check("delisted pack gone from registry detail (404)", regAfterDelist.status === 404, regAfterDelist);

  await api(`/api/v1/packs/${buildPackId}`, adminTok, { method: "DELETE" });
  try {
    const db = await getDb();
    await db.collection("atelierBuilds").deleteMany({ packId: buildPackId });
  } catch {}
  await rm(resolve(env.ATELIER_STORAGE_ROOT, "builds", buildPackId), { recursive: true, force: true }).catch(() => {});

  // ------------------------------------------------------------- summary
  await cleanupCasFixtures(env);
  await cleanupSyntheticUsers();
  await closeMongo();
  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke test crashed:", e);
  process.exit(1);
});
