/**
 * Durable live-workspace endpoints.
 *
 * GET  /packs/:packId/workspace              current authoritative snapshot
 * POST /packs/:packId/workspace/initialize   one-time initialization
 * POST /packs/:packId/workspace/operations   atomic, idempotent mutation
 */

import { MongoServerError } from "mongodb";
import type { Router } from "../router";
import type { Env } from "../env";
import { err, json, readJsonBody } from "../http";
import { requireUser } from "../auth/require";
import { assetsCol } from "../models/atelierAsset";
import { canEditPack } from "../models/atelierPack";
import { isLockActive, locksCol } from "../models/atelierLock";
import {
  applyWorkspaceOperation,
  collectWorkspaceSha256s,
  parseWorkspaceOperation,
  parseWorkspaceProject,
  publicWorkspace,
  workspaceOperationReceiptsCol,
  workspacesCol,
  type AtelierWorkspace,
  type WorkspaceOperation,
} from "../models/atelierWorkspace";
import { casExists } from "../storage/cas";
import { broadcastToPack } from "../ws/collab";
import { logActivity } from "../models/activity";
import { loadPackForUser } from "./packs";

const OPERATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const RECENT_OPERATION_LIMIT = 512;
// Leave headroom below MongoDB's 16 MiB BSON document limit for field names,
// dates, the idempotency ring, and BSON encoding overhead.
const MAX_WORKSPACE_JSON_BYTES = 12 * 1024 * 1024;

function workspaceIsTooLarge(project: AtelierWorkspace["project"]): boolean {
  return Buffer.byteLength(JSON.stringify(project), "utf8") > MAX_WORKSPACE_JSON_BYTES;
}

function receiptId(packId: string, operationId: string): string {
  return `${packId}:${operationId}`;
}

function warnReceiptFailure(action: string, packId: string, operationId: string, error: unknown): void {
  console.warn(
    `[atelier-api] workspace receipt ${action} failed for ${packId}/${operationId}:`,
    error,
  );
}

/** Per-pack serialization in the current server process; Mongo's version CAS
 * remains the correctness backstop if a second process ever writes too. */
const packQueues = new Map<string, Promise<void>>();

async function inPackQueue<T>(packId: string, work: () => Promise<T>): Promise<T> {
  const previous = packQueues.get(packId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => gate);
  packQueues.set(packId, tail);
  await previous.catch(() => {});
  try {
    return await work();
  } finally {
    release();
    if (packQueues.get(packId) === tail) packQueues.delete(packId);
  }
}

async function missingWorkspaceAssets(
  project: AtelierWorkspace["project"],
  previous?: AtelierWorkspace["project"],
): Promise<string[]> {
  const previousShas = previous ? new Set(collectWorkspaceSha256s(previous)) : null;
  const shas = collectWorkspaceSha256s(project).filter((sha) => !previousShas?.has(sha));
  if (shas.length === 0) return [];
  const assets = await assetsCol();
  const docs = await assets.find({ sha256: { $in: shas } }).toArray();
  const present = new Set<string>();
  let cursor = 0;
  const checkNext = async (): Promise<void> => {
    while (cursor < docs.length) {
      const asset = docs[cursor++]!;
      if (await casExists(asset.sha256, asset.kind)) present.add(asset.sha256);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(16, docs.length) }, () => checkNext()),
  );
  return shas.filter((sha) => !present.has(sha));
}

function touchedEntityIds(operation: WorkspaceOperation): string[] {
  const operations = operation.kind === "batch" ? operation.operations : [operation];
  const ids = new Set<string>();
  for (const op of operations) {
    if (op.kind === "entity.patch" || op.kind === "entity.delete") ids.add(op.id);
    else if (op.kind === "entity.upsert") ids.add(op.entity.id);
  }
  return [...ids];
}

async function foreignLockHolder(
  packId: string,
  operation: WorkspaceOperation,
  discordId: string,
  deviceId: string,
) {
  const ids = touchedEntityIds(operation);
  if (ids.length === 0) return null;
  const locks = await locksCol();
  const candidates = await locks.find({ packId, drawableEntryId: { $in: ids } }).toArray();
  return candidates.find(
    (lock) =>
      isLockActive(lock) &&
      (lock.lockedByDiscordId !== discordId || lock.deviceId !== deviceId),
  ) ?? null;
}

export function registerWorkspaceRoutes(router: Router, env: Env): void {
  router.get("/api/v1/packs/:packId/workspace", async ({ req, params }) => {
    const auth = await requireUser(req, env);
    if (auth instanceof Response) return auth;
    const access = await loadPackForUser(params.packId!, auth.user);
    if (access instanceof Response) return access;

    const workspaces = await workspacesCol();
    const workspace = await workspaces.findOne({ packId: access.pack.packId });
    if (!workspace) return err("workspace_not_initialized", 404);
    return json({ workspace: publicWorkspace(workspace) });
  });

  router.post("/api/v1/packs/:packId/workspace/initialize", async ({ req, params }) => {
    const auth = await requireUser(req, env);
    if (auth instanceof Response) return auth;
    const access = await loadPackForUser(params.packId!, auth.user);
    if (access instanceof Response) return access;
    if (!canEditPack(access.role)) return err("forbidden", 403);

    const body = await readJsonBody(req);
    if (!body) return err("invalid_json", 400);
    const baseRevision = body.baseRevision;
    if (typeof baseRevision !== "number" || !Number.isInteger(baseRevision) || baseRevision < 0) {
      return err("invalid_base_revision", 400);
    }
    if (baseRevision !== access.pack.headRevision) {
      return json({ error: "head_changed", headRevision: access.pack.headRevision }, 409);
    }
    const parsed = parseWorkspaceProject(body.project);
    if ("error" in parsed) return err(parsed.error, 400);
    if (workspaceIsTooLarge(parsed.ok)) return err("workspace_too_large", 413);
    const missing = await missingWorkspaceAssets(parsed.ok);
    if (missing.length > 0) return json({ error: "missing_assets", missing }, 400);

    const now = new Date();
    const workspace: AtelierWorkspace = {
      _id: access.pack.packId,
      packId: access.pack.packId,
      schemaVersion: 1,
      version: 0,
      project: parsed.ok,
      recentOperations: [],
      createdAt: now,
      updatedAt: now,
      updatedByDiscordId: auth.user.discordId,
      updatedByDeviceId: auth.device.deviceId,
    };
    const workspaces = await workspacesCol();
    try {
      await workspaces.insertOne(workspace);
    } catch (e) {
      if (!(e instanceof MongoServerError) || e.code !== 11000) throw e;
      const existing = await workspaces.findOne({ packId: access.pack.packId });
      if (!existing) throw e;
      return json({ workspace: publicWorkspace(existing) });
    }

    broadcastToPack(workspace.packId, { type: "workspace-reset", version: workspace.version });
    void logActivity("workspace.initialized", auth.user.discordId, {
      packId: workspace.packId,
      baseRevision,
    });
    return json({ workspace: publicWorkspace(workspace) }, 201);
  });

  router.post("/api/v1/packs/:packId/workspace/operations", async ({ req, params }) => {
    const auth = await requireUser(req, env);
    if (auth instanceof Response) return auth;
    const access = await loadPackForUser(params.packId!, auth.user);
    if (access instanceof Response) return access;
    if (!canEditPack(access.role)) return err("forbidden", 403);

    const body = await readJsonBody(req);
    if (!body) return err("invalid_json", 400);
    const operationId = typeof body.operationId === "string" ? body.operationId : "";
    if (!OPERATION_ID_RE.test(operationId)) return err("invalid_operation_id", 400);
    const baseVersion = body.baseVersion;
    if (typeof baseVersion !== "number" || !Number.isInteger(baseVersion) || baseVersion < 0) {
      return err("invalid_base_version", 400);
    }
    const parsedOperation = parseWorkspaceOperation(body.operation);
    if ("error" in parsedOperation) return err(parsedOperation.error, 400);

    return inPackQueue(access.pack.packId, async () => {
      const workspaces = await workspacesCol();
      const receipts = await workspaceOperationReceiptsCol();
      // A compare-and-swap retry also protects against writes from another API
      // process. Operations are set/upsert/delete based and therefore safe to
      // re-apply to the latest authoritative project.
      for (let attempt = 0; attempt < 5; attempt++) {
        const current = await workspaces.findOne({ packId: access.pack.packId });
        if (!current) return err("workspace_not_initialized", 404);
        const durableDuplicate = await receipts.findOne({
          packId: current.packId,
          operationId,
        });
        if (durableDuplicate) {
          return json({ version: current.version, duplicate: true });
        }
        const duplicate = current.recentOperations.find((item) => item.operationId === operationId);
        if (duplicate) {
          try {
            await receipts.updateOne(
              { packId: current.packId, operationId },
              {
                $setOnInsert: {
                  _id: receiptId(current.packId, operationId),
                  packId: current.packId,
                  operationId,
                  version: duplicate.version,
                  createdAt: new Date(),
                },
              },
              { upsert: true },
            );
          } catch (error) {
            // The operation is already in the atomically committed ring. A
            // receipt backfill outage must not turn an accepted retry into an
            // endless 500 loop.
            warnReceiptFailure("backfill", current.packId, operationId, error);
          }
          return json({ version: current.version, duplicate: true });
        }

        const holder = await foreignLockHolder(
          current.packId,
          parsedOperation.ok,
          auth.user.discordId,
          auth.device.deviceId,
        );
        if (holder) {
          return json({
            error: "locked",
            lock: {
              drawableEntryId: holder.drawableEntryId,
              lockedByDiscordId: holder.lockedByDiscordId,
              username: holder.username,
              expiresAt: holder.expiresAt,
            },
          }, 409);
        }

        const applied = applyWorkspaceOperation(current.project, parsedOperation.ok);
        if ("error" in applied) return err(applied.error, 400);
        if (workspaceIsTooLarge(applied.ok)) return err("workspace_too_large", 413);
        // Existing workspace refs were validated when they entered the
        // authoritative state. Only newly referenced hashes need CAS I/O;
        // metadata typing therefore stays a small constant-time write.
        const missing = await missingWorkspaceAssets(applied.ok, current.project);
        if (missing.length > 0) return json({ error: "missing_assets", missing }, 400);

        const now = new Date();
        const nextVersion = current.version + 1;
        const recentOperations = [
          ...current.recentOperations,
          { operationId, version: nextVersion },
        ].slice(-RECENT_OPERATION_LIMIT);
        const updated = await workspaces.findOneAndUpdate(
          { packId: current.packId, version: current.version },
          {
            $set: {
              project: applied.ok,
              recentOperations,
              updatedAt: now,
              updatedByDiscordId: auth.user.discordId,
              updatedByDeviceId: auth.device.deviceId,
            },
            $inc: { version: 1 },
          },
          { returnDocument: "after" },
        );
        if (!updated) continue;

        // The workspace's embedded recent-operation ring was updated in the
        // same atomic CAS, so a crash before this insert is still idempotent.
        // The durable receipt then protects retries long after the ring rolls.
        try {
          await receipts.insertOne({
            _id: receiptId(updated.packId, operationId),
            packId: updated.packId,
            operationId,
            version: updated.version,
            createdAt: now,
          });
        } catch (error) {
          if (!(error instanceof MongoServerError) || error.code !== 11000) {
            // The authoritative CAS and its embedded ring already committed.
            // Broadcasting and acknowledging must still happen; otherwise
            // peers can remain stale forever when no later operation arrives.
            warnReceiptFailure("insert", updated.packId, operationId, error);
          }
        }

        broadcastToPack(updated.packId, {
          type: "workspace-changed",
          version: updated.version,
          operationId,
          operation: parsedOperation.ok,
          byDiscordId: auth.user.discordId,
          byUsername: auth.user.username,
        });
        return json({ version: updated.version, rebased: baseVersion !== current.version });
      }
      return err("workspace_busy", 409);
    });
  });
}
