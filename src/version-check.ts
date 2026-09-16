/**
 * Server-side "update available" check. A backend can't hot-swap itself like
 * the Tauri client, but it can tell you it's behind: this compares the running
 * package.json version against the version on GitHub `master` and exposes the
 * result on /health, the landing page and the admin console. "Updating" then
 * means redeploying (on Dokploy, pushing to master already auto-redeploys).
 *
 * Meaningful only if package.json `version` is bumped when the API changes.
 * Disable with ATELIER_API_UPDATE_CHECK=off (e.g. air-gapped installs).
 */

import pkg from "../package.json";

const REPO = process.env.ATELIER_API_UPDATE_REPO ?? "grandTheftAtelier/atelier-api";
const BRANCH = process.env.ATELIER_API_UPDATE_BRANCH ?? "master";
const ENABLED = (process.env.ATELIER_API_UPDATE_CHECK ?? "on") !== "off";
const INTERVAL_MS = 30 * 60 * 1000; // 30 min

export interface UpdateStatus {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  checkedAt: string | null;
}

let status: UpdateStatus = {
  current: pkg.version,
  latest: null,
  updateAvailable: false,
  checkedAt: null,
};

/** Compare two "x.y.z" versions → 1 if a>b, -1 if a<b, 0 if equal. */
function cmpSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function fetchLatest(): Promise<string | null> {
  try {
    const res = await fetch(
      `https://raw.githubusercontent.com/${REPO}/${BRANCH}/package.json`,
      { signal: AbortSignal.timeout(5000), headers: { "cache-control": "no-cache" } },
    );
    if (!res.ok) return null;
    const remote = (await res.json()) as { version?: string };
    return typeof remote.version === "string" ? remote.version : null;
  } catch {
    return null;
  }
}

/** Refresh the cached status (best-effort; keeps the last good value on failure). */
export async function checkForUpdate(): Promise<UpdateStatus> {
  if (!ENABLED) return status;
  const latest = await fetchLatest();
  if (latest) {
    status = {
      current: pkg.version,
      latest,
      updateAvailable: cmpSemver(latest, pkg.version) > 0,
      checkedAt: new Date().toISOString(),
    };
  }
  return status;
}

export function getUpdateStatus(): UpdateStatus {
  return status;
}

/** Kick off the initial check + a periodic refresh. Non-blocking. */
export function startUpdateChecks(): void {
  if (!ENABLED) return;
  void checkForUpdate().then((s) => {
    if (s.updateAvailable) {
      console.warn(`[atelier-api] update available: running v${s.current}, latest v${s.latest} — redeploy to update`);
    }
  });
  setInterval(() => void checkForUpdate(), INTERVAL_MS).unref?.();
}
