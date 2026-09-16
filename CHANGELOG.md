# Changelog

All notable changes to **atelier-api** (the sync server for the atelier
desktop app) are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/) and the project follows
[Semantic Versioning](https://semver.org/).

> atelier-api is a server, not a distributed binary — a "release" here is a
> version tag + notes. Deployment happens by redeploying (on Dokploy, pushing
> `master` auto-redeploys). See [RELEASING.md](RELEASING.md).

## [0.4.0] — 2026-09-07

### Added

- **Discord notifications** (opt-in via `ATELIER_DISCORD_WEBHOOK_URL`). The
  server posts to a webhook when a new user is awaiting approval (with a link to
  the admin dashboard) and when a server build fails. Fire-and-forget and
  mention-safe — it never delays an auth redirect or a build, and a hostile
  username can't turn an alert into a mass ping.
- **Readiness probe** `GET /health/ready` — `200` only when MongoDB is
  reachable, else `503`, for load balancers / uptime monitors. `GET /health`
  stays a liveness probe (always `200`) but now reports a real `mongo` flag.
  Both read a background-polled snapshot, so they answer instantly even while
  MongoDB is unreachable.
- **Storage cleanup** in the admin dashboard: a read-only scan
  (`GET …/admin/web/storage/gc`) previews reclaimable orphaned CAS assets
  (uploaded but never committed to a revision), stale `tmp` uploads and
  unreferenced build ZIPs; `POST` runs it. Each category is cross-checked
  against MongoDB so nothing live is removed.
- **OpenAPI** — a machine-readable spec at `GET /openapi.json` (OpenAPI 3.1) and
  a zero-dependency browsable reference at `GET /docs`, both rendered from the
  same source so they never drift.
- **Admin dashboard UX** — a live pending-approvals badge in the sidebar,
  search + status filtering on the Users tab, an admin/member **role** toggle
  (with a matching `POST …/users/:discordId/role` endpoint) and a notifications
  status chip on the overview.

## [0.3.0] — 2026-08-26

### Added

- **Durable realtime workspaces** with monotonically versioned, idempotent
  field/entity/batch operations; authoritative reconnect snapshots; WebSocket
  operation broadcasts; enforced entity locks; full clothing/tattoo asset
  validation; and compare-and-swap serialization for multi-process safety.
  Thanks to @DasEric ([#2]).

### Fixed

- An idempotency-receipt storage failure after an already committed operation
  no longer suppresses its WebSocket broadcast or success response.
- New workspace/receipt rows use deterministic Mongo primary keys in addition
  to secondary indexes, and oversized workspaces are rejected cleanly before
  reaching MongoDB's document limit.

## [0.2.1] — 2026-07-18

### Fixed

- **Persistent storage** — dropped the Dockerfile `VOLUME /data`, which made
  Docker/Dokploy create a fresh, empty *anonymous* volume on every redeploy — so
  all uploaded assets under `/data` (CAS, build ZIPs) were lost and had to be
  re-uploaded. Mount a **named volume** at `/data` instead. On Dokploy:
  App → **Advanced → Volumes/Mounts → Volume Mount**, Volume Name
  `atelier-api-data`, Mount Path `/data`, then **Redeploy**.

## [0.2.0] — 2026-07-17

### Added

- **Update-available check** — the server compares its running version against
  `master` on GitHub and reports whether it's behind on `/health`
  (`updateAvailable` + `latestVersion`), `GET /api/v1/version`, the browser
  landing page and the admin console, plus a startup-log warning. Disable with
  `ATELIER_API_UPDATE_CHECK=off`. "Updating" the server means redeploying it.

### Changed

- **Higher clothing split limit** — team-cloud builds now split at up to **256**
  drawables per gender/slot (was 128), matching the desktop app and the raised
  FiveM/CFX `.ymt` limit.

## [0.1.0]

### Added

- Initial sync server: Discord device auth, packs registry, team-cloud builds,
  admin web console.

[0.4.0]: https://github.com/grandTheftAtelier/atelier-api/releases/tag/v0.4.0
[0.3.0]: https://github.com/grandTheftAtelier/atelier-api/releases/tag/v0.3.0
[0.2.1]: https://github.com/grandTheftAtelier/atelier-api/releases/tag/v0.2.1
[#2]: https://github.com/grandTheftAtelier/atelier-api/pull/2
[0.2.0]: https://github.com/grandTheftAtelier/atelier-api/releases/tag/v0.2.0
[0.1.0]: https://github.com/grandTheftAtelier/atelier-api/releases/tag/v0.1.0
