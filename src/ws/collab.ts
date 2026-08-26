/**
 * Realtime collaboration over WebSocket (GET /api/v1/ws?token=<access JWT>).
 *
 * The JWT is verified BEFORE the upgrade with the exact requireUser checks
 * (device alive, tokenVersion match, fresh user, pending gate) — invalid
 * tokens get a 401 Response, pending/locked users a 403. One room per packId;
 * a socket is in at most one room ("join" switches, "leave"/close exits).
 * Viewers may join read-only. REST handlers (locks, revisions) push into
 * rooms via broadcastToPack().
 *
 * Client -> server: { type: "join", packId } | { type: "leave" } | { type: "ping" }
 * Server -> client: joined | presence | lock | workspace-changed |
 *                  workspace-reset | head-changed | pong | error
 */

import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { Env } from "../env";
import { err } from "../http";
import { requireUserFromToken } from "../auth/require";
import { getFreshUser } from "../models/atelierUser";
import { packRoleFor, packsCol } from "../models/atelierPack";
import { locksCol, wsLock } from "../models/atelierLock";
import { workspacesCol } from "../models/atelierWorkspace";

export interface CollabSocketData {
  discordId: string;
  username: string;
  avatar: string | null;
  deviceId: string;
  /** Pack room this socket currently sits in (one at a time). */
  packId: string | null;
}

type CollabSocket = ServerWebSocket<CollabSocketData>;

const rooms = new Map<string, Set<CollabSocket>>();

let collabEnv: Env | null = null;

/** Called once at startup (from index.ts) — join needs env for fresh user reads. */
export function configureCollab(env: Env): void {
  collabEnv = env;
}

function send(ws: CollabSocket, msg: Record<string, unknown>): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Socket already gone — close() handles the room cleanup.
  }
}

/** Broadcast to every socket in a pack room (no-op when the room is empty). */
export function broadcastToPack(packId: string, msg: Record<string, unknown>): void {
  const room = rooms.get(packId);
  if (!room || room.size === 0) return;
  const payload = JSON.stringify(msg);
  for (const ws of room) {
    try {
      ws.send(payload);
    } catch {
      // Dead socket — ignored, close() cleans it up.
    }
  }
}

function presenceUser(ws: CollabSocket) {
  return { discordId: ws.data.discordId, username: ws.data.username, avatar: ws.data.avatar };
}

/** Room roster, deduped by discordId (multi-device users appear once). */
function rosterFor(packId: string) {
  const byId = new Map<string, ReturnType<typeof presenceUser>>();
  for (const ws of rooms.get(packId) ?? []) byId.set(ws.data.discordId, presenceUser(ws));
  return [...byId.values()];
}

function userStillInRoom(packId: string, discordId: string, deviceId?: string): boolean {
  for (const ws of rooms.get(packId) ?? []) {
    if (ws.data.discordId !== discordId) continue;
    if (deviceId === undefined || ws.data.deviceId === deviceId) return true;
  }
  return false;
}

/** Delete + broadcast all locks held by (discordId, deviceId) in a pack. */
async function releaseLocksFor(packId: string, discordId: string, deviceId: string): Promise<void> {
  try {
    const locks = await locksCol();
    const held = await locks.find({ packId, lockedByDiscordId: discordId, deviceId }).toArray();
    if (held.length === 0) return;
    await locks.deleteMany({ packId, lockedByDiscordId: discordId, deviceId });
    for (const lock of held) {
      broadcastToPack(packId, { type: "lock", event: "released", lock: wsLock(lock) });
    }
  } catch (e) {
    console.error("[atelier-api] ws lock release failed:", e);
  }
}

/**
 * Remove a socket from its room. Presence "leave" goes out only when the
 * user's LAST socket left; locks are released unless the same (discordId,
 * deviceId) still has another socket in the room (reconnect overlap).
 */
async function leaveRoom(ws: CollabSocket): Promise<void> {
  const packId = ws.data.packId;
  if (!packId) return;
  ws.data.packId = null;

  const room = rooms.get(packId);
  if (room) {
    room.delete(ws);
    if (room.size === 0) rooms.delete(packId);
  }

  if (!userStillInRoom(packId, ws.data.discordId)) {
    broadcastToPack(packId, { type: "presence", event: "leave", user: presenceUser(ws) });
  }
  if (!userStillInRoom(packId, ws.data.discordId, ws.data.deviceId)) {
    await releaseLocksFor(packId, ws.data.discordId, ws.data.deviceId);
  }
}

/** Close a socket after revoking its room membership (kick). */
async function kickSocket(ws: CollabSocket): Promise<void> {
  send(ws, { type: "error", error: "membership_revoked" });
  await leaveRoom(ws);
  try {
    ws.close(4403, "membership_revoked");
  } catch {
    // already closed
  }
}

/**
 * Kick every socket of a user from one pack room — called by the REST
 * handlers when a member is removed, so revocation is immediate instead of
 * waiting for the periodic revalidation sweep.
 */
export async function kickFromPack(packId: string, discordId: string): Promise<void> {
  for (const ws of [...(rooms.get(packId) ?? [])]) {
    if (ws.data.discordId === discordId) await kickSocket(ws);
  }
}

/** Kick a user from ALL rooms (admin lock — "lock revokes everything"). */
export async function kickUserEverywhere(discordId: string): Promise<void> {
  for (const packId of [...rooms.keys()]) {
    await kickFromPack(packId, discordId);
  }
}

async function handleJoin(ws: CollabSocket, packIdRaw: unknown): Promise<void> {
  if (!collabEnv) return send(ws, { type: "error", error: "not_ready" });
  const packId = typeof packIdRaw === "string" ? packIdRaw.trim() : "";
  if (packId === "") return send(ws, { type: "error", error: "invalid_pack_id" });

  try {
    // Fresh membership check — role/approval may have changed since upgrade.
    const user = await getFreshUser(collabEnv, ws.data.discordId);
    if (!user || user.status !== "approved") return send(ws, { type: "error", error: "forbidden" });
    const packs = await packsCol();
    const pack = await packs.findOne({ packId, archivedAt: null });
    if (!pack) return send(ws, { type: "error", error: "pack_not_found" });
    if (!packRoleFor(pack, user)) return send(ws, { type: "error", error: "forbidden" });

    if (ws.data.packId === packId) {
      // Already there — just resend the roster.
      const workspace = await (await workspacesCol()).findOne(
        { packId },
        { projection: { version: 1 } },
      );
      return send(ws, {
        type: "joined",
        packId,
        roster: rosterFor(packId),
        workspaceVersion: workspace?.version ?? null,
      });
    }
    await leaveRoom(ws); // switching rooms

    const newcomer = !userStillInRoom(packId, ws.data.discordId);
    let room = rooms.get(packId);
    if (!room) {
      room = new Set();
      rooms.set(packId, room);
    }
    room.add(ws);
    ws.data.packId = packId;

    if (newcomer) {
      for (const other of room) {
        if (other !== ws) send(other, { type: "presence", event: "join", user: presenceUser(ws) });
      }
    }
    const workspace = await (await workspacesCol()).findOne(
      { packId },
      { projection: { version: 1 } },
    );
    send(ws, {
      type: "joined",
      packId,
      roster: rosterFor(packId),
      workspaceVersion: workspace?.version ?? null,
    });
  } catch (e) {
    console.error("[atelier-api] ws join failed:", e);
    send(ws, { type: "error", error: "internal_error" });
  }
}

async function handleMessage(ws: CollabSocket, raw: string | Buffer): Promise<void> {
  let msg: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      msg = parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to invalid_message
  }
  if (!msg || typeof msg.type !== "string") return send(ws, { type: "error", error: "invalid_message" });

  switch (msg.type) {
    case "ping":
      return send(ws, { type: "pong" });
    case "join":
      return handleJoin(ws, msg.packId);
    case "leave":
      return leaveRoom(ws);
    default:
      return send(ws, { type: "error", error: "unknown_type" });
  }
}

export const collabWebsocket: WebSocketHandler<CollabSocketData> = {
  message(ws, raw) {
    void handleMessage(ws, raw);
  },
  close(ws) {
    void leaveRoom(ws);
  },
};

/**
 * Authenticate + upgrade GET /api/v1/ws. Returns undefined when the socket
 * was upgraded (Bun requires fetch to return undefined then), otherwise an
 * error Response (401 invalid token, 403 pending/locked).
 */
export async function handleWsUpgrade(
  req: Request,
  url: URL,
  server: Server<CollabSocketData>,
): Promise<Response | undefined> {
  if (!collabEnv) return err("not_ready", 503);
  const auth = await requireUserFromToken(url.searchParams.get("token"), collabEnv);
  if (auth instanceof Response) return auth;

  const data: CollabSocketData = {
    discordId: auth.user.discordId,
    username: auth.user.username,
    avatar: auth.user.avatar ?? null,
    deviceId: auth.device.deviceId,
    packId: null,
  };
  if (server.upgrade(req, { data })) return undefined;
  return err("upgrade_failed", 400);
}

// ------------------------------------------------------- lock expiry sweep

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Every 30s: (1) delete logically expired locks in ACTIVE rooms and broadcast
 * "expired" — the TTL index alone would remove them silently (and up to ~60s
 * late); (2) revalidate room membership — join-time checks alone would let
 * removed/locked users keep receiving broadcasts on an open socket.
 */
export function startLockExpirySweep(intervalMs = 30_000): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    void sweepExpiredLocks();
    void revalidateRoomMembers();
  }, intervalMs);
}

/**
 * Backstop for the proactive kicks in the REST handlers: close sockets whose
 * user is no longer approved or no longer a member of the room's pack.
 */
async function revalidateRoomMembers(): Promise<void> {
  if (rooms.size === 0 || !collabEnv) return;
  try {
    const packs = await packsCol();
    // One fresh-user read per discordId per sweep, shared across rooms.
    const userCache = new Map<string, Awaited<ReturnType<typeof getFreshUser>>>();
    const freshUser = async (discordId: string) => {
      if (!userCache.has(discordId)) {
        userCache.set(discordId, await getFreshUser(collabEnv!, discordId));
      }
      return userCache.get(discordId) ?? null;
    };

    for (const [packId, room] of [...rooms.entries()]) {
      const pack = await packs.findOne({ packId, archivedAt: null });
      for (const ws of [...room]) {
        const user = await freshUser(ws.data.discordId);
        const stillAllowed =
          pack !== null && user !== null && user.status === "approved" && packRoleFor(pack, user) !== null;
        if (!stillAllowed) await kickSocket(ws);
      }
    }
  } catch (e) {
    console.error("[atelier-api] room membership revalidation failed:", e);
  }
}

async function sweepExpiredLocks(): Promise<void> {
  if (rooms.size === 0) return;
  try {
    const locks = await locksCol();
    const now = new Date();
    const expired = await locks
      .find({ packId: { $in: [...rooms.keys()] }, expiresAt: { $lte: now } })
      .toArray();
    for (const lock of expired) {
      // Guard with expiresAt so a concurrently re-acquired lock survives.
      const res = await locks.deleteOne({
        packId: lock.packId,
        drawableEntryId: lock.drawableEntryId,
        expiresAt: { $lte: now },
      });
      if (res.deletedCount === 1) {
        broadcastToPack(lock.packId, { type: "lock", event: "expired", lock: wsLock(lock) });
      }
    }
  } catch (e) {
    console.error("[atelier-api] lock expiry sweep failed:", e);
  }
}
