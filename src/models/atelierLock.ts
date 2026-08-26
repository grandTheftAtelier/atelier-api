/**
 * atelierLocks — short-lived edit locks on drawables/tattoos within a pack
 * ("X bearbeitet gerade ..."). A lock belongs to one (discordId, deviceId)
 * and expires 90s after the last heartbeat. Mongo's TTL monitor removes
 * expired docs eventually (lag up to ~60s), so EVERY read must additionally
 * check expiresAt — see isLockActive(). The historical `drawableEntryId`
 * field now carries either entity UUID. Unique index { packId, drawableEntryId }.
 */

import { col } from "../mongodb";

export const LOCK_TTL_MS = 90_000;

export interface AtelierLock {
  packId: string;
  drawableEntryId: string;
  lockedByDiscordId: string;
  username: string;
  deviceId: string;
  acquiredAt: Date;
  expiresAt: Date;
}

export async function locksCol() {
  return col<AtelierLock>("atelierLocks");
}

/** TTL deletion lags — a doc counts as held only while expiresAt is in the future. */
export function isLockActive(lock: AtelierLock, now: Date = new Date()): boolean {
  return lock.expiresAt.getTime() > now.getTime();
}

export function publicLock(lock: AtelierLock) {
  return {
    packId: lock.packId,
    drawableEntryId: lock.drawableEntryId,
    lockedByDiscordId: lock.lockedByDiscordId,
    username: lock.username,
    deviceId: lock.deviceId,
    acquiredAt: lock.acquiredAt,
    expiresAt: lock.expiresAt,
  };
}

/** Lock payload for WebSocket broadcasts (contract: exactly these four fields). */
export function wsLock(lock: AtelierLock) {
  return {
    drawableEntryId: lock.drawableEntryId,
    lockedByDiscordId: lock.lockedByDiscordId,
    username: lock.username,
    expiresAt: lock.expiresAt,
  };
}
