# Changelog

All notable changes to **atelier-api** (the sync server for the atelier
desktop app) are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/) and the project follows
[Semantic Versioning](https://semver.org/).

> atelier-api is a server, not a distributed binary — a "release" here is a
> version tag + notes. Deployment happens by redeploying (on Dokploy, pushing
> `master` auto-redeploys). See [RELEASING.md](RELEASING.md).

## [Unreleased]

### Added

- **Durable realtime workspaces** with monotonically versioned, idempotent
  field/entity/batch operations; authoritative reconnect snapshots; WebSocket
  operation broadcasts; enforced entity locks; full clothing/tattoo asset
  validation; and compare-and-swap serialization for multi-process safety.

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

[0.2.1]: https://github.com/feelgoodrp-com/atelier-api/releases/tag/v0.2.1
[0.2.0]: https://github.com/feelgoodrp-com/atelier-api/releases/tag/v0.2.0
[0.1.0]: https://github.com/feelgoodrp-com/atelier-api/releases/tag/v0.1.0
