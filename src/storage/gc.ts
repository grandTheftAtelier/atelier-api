/**
 * Storage garbage collection — reclaims disk that the normal flow can leave
 * behind. Three safe categories, each cross-checked against MongoDB so nothing
 * live is ever removed:
 *
 *   1. Orphan CAS assets — atelierAssets with refCount <= 0 that were uploaded
 *      longer ago than the grace window. refCount only ever grows (a revision
 *      is immutable and bumps it on create), so 0 means "uploaded, never
 *      committed into a revision". The grace window (default = the 48 h upload
 *      TTL) keeps an in-flight push safe. The Mongo doc is deleted FIRST, under
 *      the same guard, and only then the file — so a revision that references
 *      the asset in the same instant wins the race and the file survives.
 *   2. Stale tmp uploads — tmp/<uuid>.part files older than the grace window.
 *      Upload sessions expire at 48 h; the TTL index drops the Mongo doc but
 *      not the on-disk part, so these accumulate.
 *   3. Orphan build artifacts — builds/<packId>/<rev>.zip with no atelierBuilds
 *      document for that { packId, revision }. Builds are a regenerable cache;
 *      any existing doc (queued/running included) reserves its path and is kept.
 *
 * Runs read-only by default (`dryRun`) so the dashboard can show what WOULD be
 * reclaimed before an admin commits to it.
 */

import { readdir, rm, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { storageRoot, casPathFor } from "./cas";
import { assetsCol } from "../models/atelierAsset";
import { buildsCol } from "../models/atelierBuild";
import { log } from "../logging/log";

export interface GcCategory {
  count: number;
  bytes: number;
}

export interface GcReport {
  dryRun: boolean;
  graceHours: number;
  orphanAssets: GcCategory;
  staleTmp: GcCategory;
  orphanBuilds: GcCategory;
  totalCount: number;
  totalBytes: number;
}

const DEFAULT_GRACE_MS = 48 * 60 * 60 * 1000;

export async function collectGarbage(opts?: { dryRun?: boolean; graceMs?: number }): Promise<GcReport> {
  const dryRun = opts?.dryRun ?? true;
  const graceMs = Math.max(0, opts?.graceMs ?? DEFAULT_GRACE_MS);
  const cutoffMs = Date.now() - graceMs;

  const [orphanAssets, staleTmp, orphanBuilds] = [
    await gcOrphanAssets(dryRun, new Date(cutoffMs)),
    await gcStaleTmp(dryRun, cutoffMs),
    await gcOrphanBuilds(dryRun),
  ];

  const report: GcReport = {
    dryRun,
    graceHours: Math.round(graceMs / 3.6e6),
    orphanAssets,
    staleTmp,
    orphanBuilds,
    totalCount: orphanAssets.count + staleTmp.count + orphanBuilds.count,
    totalBytes: orphanAssets.bytes + staleTmp.bytes + orphanBuilds.bytes,
  };

  if (!dryRun && report.totalCount > 0) {
    log.info("gc", `Reclaimed ${report.totalCount} item(s), ${report.totalBytes} bytes`, {
      orphanAssets: orphanAssets.count,
      staleTmp: staleTmp.count,
      orphanBuilds: orphanBuilds.count,
    });
  }
  return report;
}

async function gcOrphanAssets(dryRun: boolean, cutoff: Date): Promise<GcCategory> {
  const assets = await assetsCol();
  const orphans = await assets
    .find({ refCount: { $lte: 0 }, firstUploadedAt: { $lt: cutoff } })
    .toArray();

  let count = 0;
  let bytes = 0;
  for (const a of orphans) {
    if (!dryRun) {
      // Claim the doc under the SAME guard first: if a revision bumped refCount
      // in the meantime, this deletes nothing and the file is left untouched.
      const del = await assets.deleteOne({
        sha256: a.sha256,
        refCount: { $lte: 0 },
        firstUploadedAt: { $lt: cutoff },
      });
      if (del.deletedCount === 0) continue;
      try {
        await rm(casPathFor(a.sha256, a.kind), { force: true });
      } catch (e) {
        log.warn("gc", `Could not remove CAS file for ${a.sha256.slice(0, 8)}`, {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    count++;
    bytes += a.size;
  }
  return { count, bytes };
}

async function gcStaleTmp(dryRun: boolean, cutoffMs: number): Promise<GcCategory> {
  const tmpDir = join(storageRoot(), "tmp");
  let names: string[];
  try {
    names = await readdir(tmpDir);
  } catch {
    return { count: 0, bytes: 0 };
  }

  let count = 0;
  let bytes = 0;
  for (const name of names) {
    if (!name.endsWith(".part")) continue;
    const p = join(tmpDir, name);
    let s;
    try {
      s = await stat(p);
    } catch {
      continue;
    }
    if (!s.isFile() || s.mtimeMs >= cutoffMs) continue;
    if (!dryRun) {
      try {
        await rm(p, { force: true });
      } catch (e) {
        log.warn("gc", `Could not remove stale tmp file ${name}`, {
          error: e instanceof Error ? e.message : String(e),
        });
        continue;
      }
    }
    count++;
    bytes += s.size;
  }
  return { count, bytes };
}

async function gcOrphanBuilds(dryRun: boolean): Promise<GcCategory> {
  const buildsDir = join(storageRoot(), "builds");
  let packDirs: string[];
  try {
    packDirs = await readdir(buildsDir);
  } catch {
    return { count: 0, bytes: 0 };
  }

  const builds = await buildsCol();
  let count = 0;
  let bytes = 0;
  for (const packId of packDirs) {
    const packDir = join(buildsDir, packId);
    let files: string[];
    try {
      if (!(await stat(packDir)).isDirectory()) continue;
      files = await readdir(packDir);
    } catch {
      continue;
    }

    let kept = 0;
    for (const file of files) {
      const m = /^(\d+)\.zip$/u.exec(file);
      if (!m) {
        kept++; // unknown file — never touched
        continue;
      }
      const revision = parseInt(m[1]!, 10);
      const doc = await builds.findOne({ packId, revision }, { projection: { _id: 1 } });
      if (doc) {
        kept++;
        continue;
      }
      const p = join(packDir, file);
      let size = 0;
      try {
        size = (await stat(p)).size;
      } catch {
        continue;
      }
      if (!dryRun) {
        try {
          await rm(p, { force: true });
        } catch (e) {
          log.warn("gc", `Could not remove orphan build ${packId}/${file}`, {
            error: e instanceof Error ? e.message : String(e),
          });
          kept++;
          continue;
        }
      }
      count++;
      bytes += size;
    }

    // Drop a pack directory once every artifact under it is gone.
    if (!dryRun && kept === 0) await rmdir(packDir).catch(() => {});
  }
  return { count, bytes };
}
