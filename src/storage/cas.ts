/**
 * Content-addressed storage (CAS) on local disk.
 *
 * Layout under ATELIER_STORAGE_ROOT:
 *   cas/<first2hex>/<sha256>.<kind>   finalized, immutable assets
 *   tmp/<uploadId>.part               in-flight resumable uploads
 *
 * PATH SAFETY: sha256, kind and uploadId are validated against strict
 * whitelists before ANY filesystem use — nothing user-controlled ever
 * reaches a path unchecked.
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { copyFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Env } from "../env";

// `blob` covers tattoo source images (png/jpg/webp/dds) while exportName keeps
// the original extension. The CAS identity remains the content sha256.
export const ASSET_KINDS = ["ydd", "ytd", "yld", "glb", "blob"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

const SHA256_RE = /^[a-f0-9]{64}$/u;
const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

let rootDir: string | null = null;

export function isSha256Hex(v: unknown): v is string {
  return typeof v === "string" && SHA256_RE.test(v);
}

export function isAssetKind(v: unknown): v is AssetKind {
  return typeof v === "string" && (ASSET_KINDS as readonly string[]).includes(v);
}

export function configureCas(env: Env): void {
  rootDir = resolve(env.ATELIER_STORAGE_ROOT);
}

function root(): string {
  if (!rootDir) throw new Error("configureCas(env) must be called before using CAS helpers");
  return rootDir;
}

/** Absolute storage root (configured ATELIER_STORAGE_ROOT). For admin stats. */
export function storageRoot(): string {
  return root();
}

/** Create the cas/ + tmp/ directories (called once at startup). */
export function ensureCasDirs(): void {
  mkdirSync(join(root(), "cas"), { recursive: true });
  mkdirSync(join(root(), "tmp"), { recursive: true });
}

function assertSha256(sha256: string): void {
  if (!SHA256_RE.test(sha256)) throw new Error("cas: invalid sha256");
}

function assertKind(kind: string): void {
  if (!(ASSET_KINDS as readonly string[]).includes(kind)) throw new Error("cas: invalid asset kind");
}

/** Absolute final path of an asset: <root>/cas/<first2hex>/<sha256>.<kind> */
export function casPathFor(sha256: string, kind: AssetKind): string {
  assertSha256(sha256);
  assertKind(kind);
  return join(root(), "cas", sha256.slice(0, 2), `${sha256}.${kind}`);
}

/** Absolute tmp path for an in-flight upload session. */
export function tmpPathFor(uploadId: string): string {
  if (!UPLOAD_ID_RE.test(uploadId)) throw new Error("cas: invalid uploadId");
  return join(root(), "tmp", `${uploadId}.part`);
}

/** Throws unless the (resolved) path lives inside <root>/tmp. */
function assertInsideTmp(tmpPath: string): string {
  const abs = resolve(tmpPath);
  const tmpRoot = join(root(), "tmp");
  if (!abs.startsWith(tmpRoot + sep)) throw new Error("cas: tmpPath escapes the tmp directory");
  return abs;
}

export async function casExists(sha256: string, kind: AssetKind): Promise<boolean> {
  try {
    const s = await stat(casPathFor(sha256, kind));
    return s.isFile();
  } catch {
    return false;
  }
}

/**
 * Open a read stream over a finalized asset; optional single byte range
 * (endInclusive as in HTTP Range headers).
 */
export function openReadStream(
  sha256: string,
  kind: AssetKind,
  range?: { start: number; endInclusive: number },
): ReadableStream<Uint8Array> {
  const file = Bun.file(casPathFor(sha256, kind));
  if (range) return file.slice(range.start, range.endInclusive + 1).stream();
  return file.stream();
}

/** Remove an in-flight tmp file (best effort, missing file is fine). */
export async function deleteTmp(tmpPath: string): Promise<void> {
  const abs = assertInsideTmp(tmpPath);
  await rm(abs, { force: true });
}

/**
 * Import an EXISTING file from disk into the CAS (server-side, no upload
 * session): stream it through sha256, then copy it to its content address.
 * Idempotent — an already-present asset is left untouched. Used by the
 * creative one-shot import; the source file is never modified or moved.
 */
export async function casImportFile(
  sourcePath: string,
  kind: AssetKind,
): Promise<{ sha256: string; size: number; diskPath: string }> {
  assertKind(kind);

  const file = Bun.file(sourcePath);
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of file.stream()) {
    hash.update(chunk);
    size += chunk.byteLength;
  }
  const sha256 = hash.digest("hex");

  const finalPath = casPathFor(sha256, kind);
  if (!(await casExists(sha256, kind))) {
    mkdirSync(dirname(finalPath), { recursive: true });
    // Copy via a temp name + rename so a concurrent import never sees a
    // half-written CAS file (rename is atomic on the same volume).
    const partPath = `${finalPath}.import-${process.pid}-${Date.now()}.part`;
    await copyFile(sourcePath, partPath);
    try {
      await rename(partPath, finalPath);
    } catch (e) {
      await rm(partPath, { force: true }).catch(() => {});
      if (!(await casExists(sha256, kind))) throw e;
    }
  }
  return { sha256, size, diskPath: finalPath };
}

/**
 * Finalize an upload: stream the tmp file through sha256, verify it matches
 * the expected hash and rename it into the CAS. Idempotent — if the asset
 * already exists the tmp file is simply discarded.
 */
export async function finalizeFromTmp(
  tmpPath: string,
  expectedSha256: string,
  kind: AssetKind,
): Promise<{ ok: true; diskPath: string } | { ok: false; actualSha256: string }> {
  assertSha256(expectedSha256);
  assertKind(kind);
  const tmpAbs = assertInsideTmp(tmpPath);

  const hash = createHash("sha256");
  for await (const chunk of Bun.file(tmpAbs).stream()) {
    hash.update(chunk);
  }
  const actualSha256 = hash.digest("hex");
  if (actualSha256 !== expectedSha256) return { ok: false, actualSha256 };

  const finalPath = casPathFor(expectedSha256, kind);
  if (await casExists(expectedSha256, kind)) {
    await rm(tmpAbs, { force: true });
    return { ok: true, diskPath: finalPath };
  }

  mkdirSync(dirname(finalPath), { recursive: true });
  try {
    await rename(tmpAbs, finalPath);
  } catch (e) {
    // Lost a race against a concurrent finalize of the same content — fine.
    if (await casExists(expectedSha256, kind)) {
      await rm(tmpAbs, { force: true });
      return { ok: true, diskPath: finalPath };
    }
    throw e;
  }
  return { ok: true, diskPath: finalPath };
}
