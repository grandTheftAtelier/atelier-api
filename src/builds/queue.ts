/**
 * In-process build queue: FIFO over atelierBuilds with a concurrency cap
 * (ATELIER_BUILD_CONCURRENCY, default 2). One artifact per immutable
 * { packId, revision } at <ATELIER_STORAGE_ROOT>/builds/<packId>/<revision>.zip.
 *
 * ensureBuild() is the single entry point used by both the user-lane build
 * routes and the service-lane registry download: it returns the cached done
 * build, re-enqueues failed/orphaned ones and creates the document for new
 * requests (the unique { packId, revision } index settles races).
 *
 * Status transitions broadcast { type: "build-status", buildId, status } into
 * the pack's collab room; completions land in the activity log.
 */

import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Env } from "../env";
import { buildsCol, type AtelierBuild } from "../models/atelierBuild";
import { packsCol } from "../models/atelierPack";
import { revisionsCol, collectReferencedSha256s } from "../models/atelierRevision";
import { assetsCol } from "../models/atelierAsset";
import { casPathFor } from "../storage/cas";
import { logActivity } from "../models/activity";
import { broadcastToPack } from "../ws/collab";
import { buildFivemResourceZip, sanitizeDlcName, sanitizeResourceName } from "../cloth/fivem-export";
import { notifyBuildFailed } from "../notify/discord";
import { log } from "../logging/log";

let queueEnv: Env | null = null;
const pending: string[] = []; // buildIds, FIFO
let running = 0;

/** Failed builds retry instantly this often, then only once per cooldown. */
const MAX_QUICK_ATTEMPTS = 3;
const RETRY_COOLDOWN_MS = 15 * 60 * 1000;

function env(): Env {
  if (!queueEnv) throw new Error("configureBuildQueue(env) must be called first");
  return queueEnv;
}

/** Absolute artifact path — packId is a server-generated UUID, revision an int. */
export function buildArtifactPathFor(packId: string, revision: number): string {
  if (!/^[0-9a-f-]{36}$/u.test(packId)) throw new Error("builds: invalid packId");
  if (!Number.isInteger(revision) || revision < 1) throw new Error("builds: invalid revision");
  return join(resolve(env().ATELIER_STORAGE_ROOT), "builds", packId, `${revision}.zip`);
}

/**
 * Called once at startup. Re-queues builds a previous process left behind
 * ("running" without a survivor) and resumes anything still queued.
 */
export function configureBuildQueue(e: Env): void {
  queueEnv = e;
  void (async () => {
    try {
      const builds = await buildsCol();
      await builds.updateMany({ status: "running" }, { $set: { status: "queued", startedAt: null } });
      const open = await builds.find({ status: "queued" }).sort({ createdAt: 1 }).toArray();
      for (const b of open) enqueue(b.buildId);
    } catch (err) {
      console.warn("[atelier-api] build queue recovery skipped (mongo unreachable?):", (err as Error).message);
    }
  })();
}

function enqueue(buildId: string): void {
  pending.push(buildId);
  pump();
}

function pump(): void {
  while (running < env().ATELIER_BUILD_CONCURRENCY && pending.length > 0) {
    const buildId = pending.shift()!;
    running++;
    void runBuild(buildId)
      .catch((e) => console.error(`[atelier-api] build ${buildId} crashed:`, e))
      .finally(() => {
        running--;
        pump();
      });
  }
}

function notify(packId: string, buildId: string, status: AtelierBuild["status"]): void {
  broadcastToPack(packId, { type: "build-status", buildId, status });
}

/**
 * Return the build for { packId, revision }, creating/re-enqueuing as needed:
 *   - done + artifact on disk  -> returned as-is (cache hit)
 *   - done + artifact MISSING  -> re-enqueued (disk cleanup happened)
 *   - error                    -> re-enqueued in place (same buildId)
 *   - queued/running           -> returned as-is
 *   - none                     -> created + enqueued
 */
export async function ensureBuild(
  packId: string,
  revision: number,
  requestedByDiscordId: string,
): Promise<AtelierBuild> {
  const builds = await buildsCol();
  const existing = await builds.findOne({ packId, revision });

  if (existing) {
    if (existing.status === "done" && existing.artifactPath) {
      const onDisk = await stat(existing.artifactPath).then((s) => s.isFile()).catch(() => false);
      if (onDisk) return existing;
    }
    if (existing.status === "queued" || existing.status === "running") return existing;

    // Churn guard: a deterministically failing pack must not turn every
    // registry-download click into a fresh CPU-heavy build run. After
    // MAX_QUICK_ATTEMPTS failures, further retries only happen once per
    // RETRY_COOLDOWN window — until then the error doc is returned as-is.
    if (existing.status === "error" && (existing.attempts ?? 1) >= MAX_QUICK_ATTEMPTS) {
      const lastFinished = existing.finishedAt?.getTime() ?? 0;
      if (Date.now() - lastFinished < RETRY_COOLDOWN_MS) return existing;
    }

    // error (retry allowed), or done with a vanished artifact -> reset + re-enqueue.
    const reset = await builds.findOneAndUpdate(
      { buildId: existing.buildId, status: { $in: ["error", "done"] } },
      {
        $set: {
          status: "queued",
          error: null,
          sizeBytes: null,
          artifactPath: null,
          report: null,
          startedAt: null,
          finishedAt: null,
          requestedByDiscordId,
          createdAt: new Date(),
        },
        $inc: { attempts: 1 },
      },
      { returnDocument: "after" },
    );
    if (reset) {
      notify(packId, reset.buildId, "queued");
      enqueue(reset.buildId);
      return reset;
    }
    // Lost a race against a concurrent reset — return the current doc.
    return (await builds.findOne({ packId, revision })) ?? existing;
  }

  const build: AtelierBuild = {
    buildId: randomUUID(),
    packId,
    revision,
    status: "queued",
    error: null,
    sizeBytes: null,
    artifactPath: null,
    report: null,
    requestedByDiscordId,
    attempts: 1,
    createdAt: new Date(),
    startedAt: null,
    finishedAt: null,
  };
  try {
    await builds.insertOne({ ...build });
  } catch {
    // Duplicate { packId, revision } — someone else inserted concurrently.
    const winner = await builds.findOne({ packId, revision });
    if (winner) return winner;
    throw new Error("builds: insert failed without a concurrent winner");
  }
  notify(packId, build.buildId, "queued");
  enqueue(build.buildId);
  return build;
}

/**
 * Force a rebuild of { packId, revision } even when a done artifact is cached
 * — used by the admin dashboard after changing the build-config/fxmanifest (the
 * cache key is only { packId, revision }, so config edits need an explicit
 * rebuild). An in-flight build is returned as-is; otherwise the doc is reset
 * and re-enqueued, or created when none exists yet.
 */
export async function forceRebuild(
  packId: string,
  revision: number,
  requestedByDiscordId: string,
): Promise<AtelierBuild> {
  const builds = await buildsCol();
  const existing = await builds.findOne({ packId, revision });
  if (!existing) return ensureBuild(packId, revision, requestedByDiscordId);
  if (existing.status === "queued" || existing.status === "running") return existing;

  const reset = await builds.findOneAndUpdate(
    { buildId: existing.buildId, status: { $in: ["error", "done"] } },
    {
      $set: {
        status: "queued",
        error: null,
        sizeBytes: null,
        artifactPath: null,
        report: null,
        startedAt: null,
        finishedAt: null,
        requestedByDiscordId,
        createdAt: new Date(),
      },
      $inc: { attempts: 1 },
    },
    { returnDocument: "after" },
  );
  if (reset) {
    notify(packId, reset.buildId, "queued");
    enqueue(reset.buildId);
    return reset;
  }
  return (await builds.findOne({ packId, revision })) ?? existing;
}

async function runBuild(buildId: string): Promise<void> {
  const builds = await buildsCol();
  const build = await builds.findOneAndUpdate(
    { buildId, status: "queued" },
    { $set: { status: "running", startedAt: new Date() } },
    { returnDocument: "after" },
  );
  if (!build) return; // deleted or already taken
  notify(build.packId, buildId, "running");
  log.info("build", `Build started (pack ${build.packId.slice(0, 8)} rev ${build.revision})`, {
    buildId,
    packId: build.packId,
    revision: build.revision,
  });

  try {
    const packs = await packsCol();
    const pack = await packs.findOne({ packId: build.packId });
    if (!pack) throw new Error("pack_not_found");
    const revisions = await revisionsCol();
    const revision = await revisions.findOne({ packId: build.packId, revision: build.revision });
    if (!revision) throw new Error("revision_not_found");

    // sha256 -> CAS path via the asset docs (the kind decides the extension).
    const shas = collectReferencedSha256s(revision.drawables);
    const assets = await assetsCol();
    const assetDocs = shas.length > 0 ? await assets.find({ sha256: { $in: shas } }).toArray() : [];
    const kindBySha = new Map(assetDocs.map((a) => [a.sha256, a.kind]));
    const readAsset = async (sha256: string): Promise<Uint8Array | null> => {
      const kind = kindBySha.get(sha256);
      if (!kind) return null;
      const file = Bun.file(casPathFor(sha256, kind));
      if (!(await file.exists())) return null;
      return new Uint8Array(await file.arrayBuffer());
    };

    // dlcName drives stream names + YMT hashes — it MUST match the desktop
    // build of the same revision (revision.dlcName, pushed from the project
    // settings). The slug is only the fallback for pre-Phase-3 revisions.
    const buildCfg = pack.buildConfig ?? null;
    const dlcName = sanitizeDlcName(revision.dlcName ?? pack.slug);
    // Admin build-config can override the resource folder name + fxmanifest.
    // Empty/whitespace values fall back to the default (dlcName/slug).
    const resourceName = sanitizeResourceName(
      buildCfg?.resourceName?.trim() || revision.dlcName || pack.slug,
    );
    const { zip, report } = await buildFivemResourceZip(revision.drawables, readAsset, {
      dlcName,
      resourceName,
      fxmanifestTemplate: buildCfg?.fxmanifestTemplate?.trim() || undefined,
    });

    // Write atomically: .part first, rename into place.
    const artifactPath = buildArtifactPathFor(build.packId, build.revision);
    await mkdir(dirname(artifactPath), { recursive: true });
    const partPath = `${artifactPath}.part`;
    await Bun.write(partPath, zip);
    await rm(artifactPath, { force: true }).catch(() => {});
    await rename(partPath, artifactPath);

    await builds.updateOne(
      { buildId },
      {
        $set: {
          status: "done",
          sizeBytes: zip.byteLength,
          artifactPath,
          report,
          finishedAt: new Date(),
        },
      },
    );
    notify(build.packId, buildId, "done");
    log.info(
      "build",
      `Build done (pack ${build.packId.slice(0, 8)} rev ${build.revision}): ` +
        `${(zip.byteLength / 1024).toFixed(0)} KiB, ${report.resources.length} resource(s), ` +
        `${report.warnings.length} warning(s)`,
      { buildId, packId: build.packId, revision: build.revision },
    );
    void logActivity("build.completed", build.requestedByDiscordId, {
      buildId,
      packId: build.packId,
      revision: build.revision,
      sizeBytes: zip.byteLength,
      resources: report.resources.length,
      warnings: report.warnings.length,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await builds.updateOne(
      { buildId },
      { $set: { status: "error", error: message.slice(0, 500), finishedAt: new Date() } },
    );
    notify(build.packId, buildId, "error");
    log.error(
      "build",
      `Build failed (pack ${build.packId.slice(0, 8)} rev ${build.revision}): ${message.slice(0, 200)}`,
      { buildId, packId: build.packId, revision: build.revision },
    );
    void logActivity("build.failed", build.requestedByDiscordId, {
      buildId,
      packId: build.packId,
      revision: build.revision,
      error: message.slice(0, 500),
    });
    void notifyBuildFailed({
      packId: build.packId,
      revision: build.revision,
      buildId,
      error: message,
    });
    console.error(`[atelier-api] build ${buildId} failed:`, e);
  }
}
