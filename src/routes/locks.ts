/**
 * Entity edit locks within a pack ("wird gerade bearbeitet"). The route keeps
 * the historical `drawableEntryId` parameter for wire compatibility:
 *   POST   /api/v1/packs/:packId/locks                             acquire/extend (editor+)
 *   PUT    /api/v1/packs/:packId/locks/:drawableEntryId/heartbeat  extend own lock
 *   DELETE /api/v1/packs/:packId/locks/:drawableEntryId[?force=1]  release own / break others' (force)
 *
 * A lock expires 90s after the last heartbeat. The TTL index lags up to ~60s,
 * so a doc only counts as held while expiresAt is in the future. Viewers are
 * 403 everywhere; all state changes broadcast to the pack's WebSocket room.
 */

import { MongoServerError } from "mongodb";
import type { Router } from "../router";
import type { Env } from "../env";
import { json, err, readJsonBody } from "../http";
import { requireUser } from "../auth/require";
import { canEditPack } from "../models/atelierPack";
import { isLockActive, locksCol, publicLock, wsLock, LOCK_TTL_MS } from "../models/atelierLock";
import { loadPackForUser } from "./packs";
import { broadcastToPack } from "../ws/collab";
import { logActivity } from "../models/activity";

export function registerLockRoutes(router: Router, env: Env): void {
  // ------------------------------------------------ GET /packs/:packId/locks
  // Active locks snapshot for room joiners — without it, pre-existing foreign
  // locks become visible only with the next broadcast/heartbeat (<=30s gap).
  // Viewers may read (locks are display-state, not an editing capability).
  router.get("/api/v1/packs/:packId/locks", async ({ req, params }) => {
    const auth = await requireUser(req, env);
    if (auth instanceof Response) return auth;
    const access = await loadPackForUser(params.packId!, auth.user);
    if (access instanceof Response) return access;

    const locks = await locksCol();
    const now = new Date();
    const active = await locks
      .find({ packId: access.pack.packId, expiresAt: { $gt: now } })
      .toArray();
    return json({ locks: active.map(publicLock) });
  });

  // ----------------------------------------------- POST /packs/:packId/locks
  router.post("/api/v1/packs/:packId/locks", async ({ req, params }) => {
    const auth = await requireUser(req, env);
    if (auth instanceof Response) return auth;
    const access = await loadPackForUser(params.packId!, auth.user);
    if (access instanceof Response) return access;
    if (!canEditPack(access.role)) return err("forbidden", 403);

    const body = await readJsonBody(req);
    if (!body) return err("invalid_json", 400);
    const drawableEntryId =
      typeof body.drawableEntryId === "string" ? body.drawableEntryId.trim() : "";
    if (drawableEntryId === "" || drawableEntryId.length > 100) {
      return err("invalid_drawable_entry_id", 400);
    }

    const locks = await locksCol();
    const packId = access.pack.packId;

    // Two attempts: losing an upsert race against another acquirer surfaces
    // as a duplicate-key error on { packId, drawableEntryId }.
    for (let attempt = 0; attempt < 2; attempt++) {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);
      try {
        // Acquire when the slot is free, logically expired, or already mine.
        // Pipeline update so acquiredAt survives an extend of my own live
        // lock but resets when taking over an expired one.
        const lock = await locks.findOneAndUpdate(
          {
            packId,
            drawableEntryId,
            $or: [{ lockedByDiscordId: auth.user.discordId }, { expiresAt: { $lte: now } }],
          },
          [
            {
              $set: {
                packId,
                drawableEntryId,
                acquiredAt: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ["$lockedByDiscordId", auth.user.discordId] },
                        { $gt: ["$expiresAt", now] },
                      ],
                    },
                    "$acquiredAt",
                    now,
                  ],
                },
                lockedByDiscordId: auth.user.discordId,
                username: auth.user.username,
                deviceId: auth.device.deviceId,
                expiresAt,
              },
            },
          ],
          { upsert: true, returnDocument: "after" },
        );
        if (!lock) continue;
        broadcastToPack(packId, { type: "lock", event: "acquired", lock: wsLock(lock) });
        return json({ lock: publicLock(lock) });
      } catch (e) {
        if (!(e instanceof MongoServerError) || e.code !== 11000) throw e;
      }
      const holder = await locks.findOne({ packId, drawableEntryId });
      if (holder && isLockActive(holder) && holder.lockedByDiscordId !== auth.user.discordId) {
        return json({ error: "locked", lock: publicLock(holder) }, 409);
      }
      // Holder vanished/expired between upsert and read — retry once.
    }
    return err("lock_conflict", 409);
  });

  // -------------------- PUT /packs/:packId/locks/:drawableEntryId/heartbeat
  router.put("/api/v1/packs/:packId/locks/:drawableEntryId/heartbeat", async ({ req, params }) => {
    const auth = await requireUser(req, env);
    if (auth instanceof Response) return auth;
    const access = await loadPackForUser(params.packId!, auth.user);
    if (access instanceof Response) return access;
    if (!canEditPack(access.role)) return err("forbidden", 403);

    const now = new Date();
    const locks = await locksCol();
    // Only the holding DEVICE may extend (a takeover from another device
    // moved the lock away); a logically expired lock is already gone.
    const lock = await locks.findOneAndUpdate(
      {
        packId: access.pack.packId,
        drawableEntryId: params.drawableEntryId!,
        lockedByDiscordId: auth.user.discordId,
        deviceId: auth.device.deviceId,
        expiresAt: { $gt: now },
      },
      { $set: { expiresAt: new Date(now.getTime() + LOCK_TTL_MS) } },
      { returnDocument: "after" },
    );
    if (!lock) return err("lock_not_found", 404);
    return json({ lock: publicLock(lock) });
  });

  // ------------------------- DELETE /packs/:packId/locks/:drawableEntryId
  router.delete("/api/v1/packs/:packId/locks/:drawableEntryId", async ({ req, url, params }) => {
    const auth = await requireUser(req, env);
    if (auth instanceof Response) return auth;
    const access = await loadPackForUser(params.packId!, auth.user);
    if (access instanceof Response) return access;
    if (!canEditPack(access.role)) return err("forbidden", 403);

    const packId = access.pack.packId;
    const drawableEntryId = params.drawableEntryId!;
    const force = url.searchParams.get("force") === "1";

    const locks = await locksCol();
    const lock = await locks.findOne({ packId, drawableEntryId });
    // Idempotent: nothing there (or only an expired leftover) -> ok.
    if (!lock || !isLockActive(lock)) {
      if (lock) await locks.deleteOne({ packId, drawableEntryId, expiresAt: lock.expiresAt });
      return json({ ok: true });
    }

    const own = lock.lockedByDiscordId === auth.user.discordId;
    if (!own && !force) return json({ error: "locked", lock: publicLock(lock) }, 409);

    // Guard with expiresAt so a concurrently re-acquired lock is not destroyed.
    const res = await locks.deleteOne({
      packId,
      drawableEntryId,
      lockedByDiscordId: lock.lockedByDiscordId,
      expiresAt: lock.expiresAt,
    });
    if (res.deletedCount === 0) return json({ ok: true }); // raced away — already released

    if (own) {
      broadcastToPack(packId, { type: "lock", event: "released", lock: wsLock(lock) });
    } else {
      // Force-break of someone else's lock: audit-logged + broadcast.
      void logActivity("lock.broken", auth.user.discordId, {
        packId,
        drawableEntryId,
        lockedByDiscordId: lock.lockedByDiscordId,
      });
      broadcastToPack(packId, { type: "lock", event: "broken", lock: wsLock(lock) });
    }
    return json({ ok: true });
  });
}
