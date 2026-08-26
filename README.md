<div align="center">

<img src="assets/atelier-logo.png" width="100" alt="atelier" />

# atelier-api

**The backend for [atelier](https://github.com/feelgoodrp-com/atelier)** —
Discord login, team cloud, storage and server builds for the GTA-V
addon-clothing tool.

[![License: PolyForm NC 1.0.0](https://img.shields.io/badge/License-PolyForm%20NC%201.0.0-5865F2)](LICENSE.md)
&nbsp;![Bun](https://img.shields.io/badge/Bun-1.x-1f1f1f)
&nbsp;![MongoDB](https://img.shields.io/badge/MongoDB-1f1f1f)
&nbsp;![Port 3095](https://img.shields.io/badge/Port-3095-1f1f1f)

[**atelier**](https://github.com/feelgoodrp-com/atelier) ·
[In-game viewer](https://github.com/feelgoodrp-com/atelier-fivem) ·
[Discord](https://discord.gg/blpd)

</div>

---

Collaborative backend for the atelier desktop app: Discord login, device
tokens, user approval, admin management including a **web admin dashboard**
(`/admin`), CAS uploads, packs/revisions, locks, WebSocket collaboration, plus
server builds, publish/registry and creative import.

- **Runtime:** Bun (`Bun.serve`, no framework)
- **Database:** MongoDB (raw driver, no ORM), DB `atelier` (configurable)
- **Port:** `3095`
- **Error convention:** `{ "error": "message" }`

> ⚠️ **Server-build limitation (YMT):** The real binary `CPedVariationInfo`
> YMTs (`mp_m_freemode_01_<dlc>.ymt`, `mp_creaturemetadata_*.ymt`) can only be
> produced by the **desktop build** of the atelier app (CodeWalker/.NET).
> Server builds contain everything **except** the YMTs, plus a
> `stream/ATELIER_README.txt` note; `atelier-build.json` carries
> `"ymt": "missing-server-build"`. Registry downloads are therefore suitable for
> preview/distribution — complete in-game packs come from desktop builds. A
> future ymt-service sidecar deployment can close the gap.

## Architecture

```
atelier-api/
├── src/
│   ├── index.ts            Bun.serve + route registration + CORS
│   ├── env.ts              Typed env validation (fail fast)
│   ├── router.ts           Mini router (method + path + :params, 0 deps)
│   ├── mongodb.ts          Lazy singleton client + ensureIndexes()
│   ├── http.ts             json/err/redirect/cookie/loopback helpers
│   ├── auth/
│   │   ├── jwt.ts          HS256 JWT sign/verify (node:crypto, 0 deps)
│   │   ├── device-auth.ts  atelierDevices + refresh-token rotation
│   │   ├── discord.ts      reusable Discord OAuth helpers (web admin login)
│   │   ├── admin-web.ts    /admin browser session (cookie) + CSRF + admin gate
│   │   └── require.ts      requireUser / requireAdmin / requireService
│   ├── models/
│   │   ├── atelierUser.ts  atelierUsers (pending/approved/locked)
│   │   ├── authCode.ts     atelierAuthCodes (one-time codes, TTL 60s)
│   │   ├── atelierAsset.ts atelierAssets (CAS metadata)
│   │   ├── atelierUpload.ts atelierUploads (resumable sessions)
│   │   ├── atelierPack.ts  atelierPacks (+ publish state)
│   │   ├── atelierRevision.ts atelierRevisions (immutable snapshots)
│   │   ├── atelierWorkspace.ts durable mutable realtime collaboration head
│   │   ├── atelierLock.ts  atelierLocks (enforced edit locks)
│   │   ├── atelierBuild.ts atelierBuilds (server-build cache)
│   │   └── activity.ts     atelierActivity (audit log)
│   ├── storage/
│   │   ├── cas.ts          Content-addressed storage (+ casImportFile)
│   │   └── stats.ts        disk-usage stats for the admin overview
│   ├── logging/log.ts      in-memory ring-buffer log (admin live logs + SSE)
│   ├── web/
│   │   ├── pages.ts        public HTML (landing + OAuth error pages)
│   │   └── admin/pages.ts  admin login + dashboard shell HTML
│   ├── cloth/fivem-export.ts  FiveM resource builder (without YMTs, see below)
│   ├── builds/queue.ts     In-process build queue (concurrency, artifacts)
│   ├── ws/collab.ts        WebSocket rooms (live operations, presence, locks)
│   └── routes/
│       ├── auth.ts         Discord OAuth start/callback (+ dev fake mode)
│       ├── devices.ts      exchange/refresh/logout + device management
│       ├── me.ts           GET /api/v1/me
│       ├── admin.ts        user list, approve/lock/role
│       ├── uploads.ts      chunk uploads into the CAS
│       ├── assets.ts       asset check + download (ETag/Range)
│       ├── packs.ts        packs/revisions/members + publish
│       ├── workspaces.ts   snapshots + atomic/idempotent live operations
│       ├── presence.ts     presence REST
│       ├── locks.ts        drawable locks
│       ├── builds.ts       server builds (status + artifact ZIP)
│       ├── registry.ts     registry for community websites (service lane)
│       ├── import-creative.ts  one-shot import from creative
│       └── admin-web.ts    /admin dashboard (HTML + /api/v1/admin/web/* + assets)
├── assets/admin/           dashboard styles + client script (app.css, app.js)
└── scripts/
    ├── smoke.ts            E2E smoke test against a running server
    └── sync-roundtrip.ts   push/pull roundtrip (pack, chunk upload, revision, download)
```

### Mongo collections

| Collection         | Contents                                                          | Indexes |
| ------------------ | ----------------------------------------------------------------- | ------ |
| `atelierUsers`     | discordId, username, avatar, status, role, createdAt, approvedBy… | `discordId` unique |
| `atelierAuthCodes` | one-time codes (browser → app), TTL 60 s, single-use              | `expiresAt` TTL, `code` unique |
| `atelierDevices`   | deviceId, refreshTokenHash (sha256), tokenVersion, revokedAt …    | `deviceId` unique, `discordId`, `refreshTokenHash` |
| `atelierActivity`  | audit log `{ type, actorDiscordId, ts, data }`                    | `ts` |
| `atelierAssets`    | CAS assets `{ sha256, size, kind, diskPath, refCount }`           | `sha256` unique |
| `atelierUploads`   | resumable upload sessions (chunks, TTL 48 h)                      | `uploadId` unique, TTL |
| `atelierPacks`     | packs incl. `publish { visibility, targets, publishedRevision }`  | `packId` unique, `slug` (active) unique |
| `atelierRevisions` | immutable drawable snapshots                                      | `{ packId, revision }` unique |
| `atelierWorkspaces`| authoritative live project, monotonic version + operation dedupe   | `packId` unique |
| `atelierWorkspaceOperations` | permanent idempotency receipts for offline retries       | `{ packId, operationId }` unique |
| `atelierLocks`     | enforced entity edit locks (TTL)                                  | `{ packId, drawableEntryId }` unique, TTL |
| `atelierBuilds`    | server builds (cache per revision, artifact path, report)         | `buildId` unique, `{ packId, revision }` unique |

## Auth flow

```
desktop app                 atelier-api                      Discord
    |                            |                              |
    | GET /auth/discord/start?redirect_uri=http://127.0.0.1:<port>/cb
    |--------------------------->|                              |
    |                            |-- 302 (signed state, ------->|
    |                            |    nonce cookie)             |
    |                            |                              |
    |                            |<-- 302 /auth/discord/callback|
    |                            |    ?code&state               |
    |                            |-- code -> token, /users/@me  |
    |                            |   upsert atelierUsers        |
    |                            |   (new => status pending)    |
    |<-- 302 {redirect_uri}?code=<one-time, 60s TTL> -----------|
    |                            |
    | POST /auth/device/exchange { code, redirect_uri, device }
    |--------------------------->|  burn the single-use code,
    |                            |  create the device
    |<-- { accessToken (JWT 1h), refreshToken (90d, rotating), user }
    |                            |
    | ... accessToken expired ...
    | POST /auth/device/refresh { refreshToken }
    |--------------------------->|  verify hash, re-read user,
    |                            |  ROTATION: old token invalid immediately
    |<-- { accessToken, refreshToken (NEW), user }
```

- **Access token:** JWT HS256, 1 h, claims `discordId/username/avatar/deviceId/tokenVersion/role/status`.
- **Refresh token:** 48 random bytes hex, stored only as a sha256 hash, 90 days, rotated on every refresh.
- **tokenVersion:** bumped on revoke/logout/lock → all of the device's issued JWTs invalid immediately.
- **Pending gate:** every `/api/v1/*` endpoint except `/api/v1/me` and the auth/device routes returns
  `403 { "error": "pending_approval" }` for non-approved users (locked: `403 { "error": "locked" }`).
- **Admin override:** Discord IDs from `ATELIER_ADMIN_DISCORD_IDS` are forced to `status=approved` +
  `role=admin` on every login/refresh/request.

### Dev fake mode (no Discord app)

When `ATELIER_DEV_FAKE_AUTH=1` **and** the Discord credentials are `CHANGEME`/empty
(and `NODE_ENV != production`), `/auth/discord/start` skips Discord entirely: the
fake user (`ATELIER_DEV_FAKE_DISCORD_ID`, username `DevUser`) is created directly
and redirected back to the app with a one-time code. Only in fake mode are the
query overrides `&dev_id=<discordId>` and `&dev_username=` allowed (for multi-user
testing, see `scripts/smoke.ts`).

## Environment variables

Bun loads `.env` and `.env.local` automatically. Template: `.env.example`.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `PORT` | no | `3095` | HTTP port |
| `HOST` | no | `127.0.0.1` | bind address (deployment: `0.0.0.0`) |
| `MONGODB_URI` | **yes** | – | MongoDB connection string (Atlas/local) |
| `MONGODB_DB_NAME` | no | `atelier` | database name (configurable) |
| `MONGODB_DNS_SERVERS` | no | – | DNS override (e.g. `8.8.8.8`) for `querySrv ECONNREFUSED` on Bun/Windows |
| `ATELIER_PUBLIC_ORIGIN` | no | `http://127.0.0.1:3095` | public base URL (Discord redirect) |
| `ATELIER_DISCORD_CLIENT_ID` | no* | `CHANGEME` | Discord app client ID |
| `ATELIER_DISCORD_CLIENT_SECRET` | no* | `CHANGEME` | Discord app client secret |
| `ATELIER_ADMIN_DISCORD_IDS` | no | empty | comma-separated IDs, always approved+admin |
| `ATELIER_JWT_SECRET` | **yes** | – | HS256 secret (min. 32 chars) |
| `ATELIER_SERVICE_TOKEN` | **yes** | – | header `x-fg-service-token` for service-to-service |
| `ATELIER_STORAGE_ROOT` | no | `./data` | file storage (`cas/`, `tmp/`, `builds/`) |
| `ATELIER_BUILD_CONCURRENCY` | no | `2` | concurrent server builds |
| `ATELIER_CREATIVE_CLOTH_ROOT` | no | empty | creative `CLOTH_UPLOAD_ROOT` for the creative import (empty = endpoint 503) |
| `ATELIER_DEV_FAKE_AUTH` | no | `0` | `1` = fake login (dev only, see above) |
| `ATELIER_DEV_FAKE_DISCORD_ID` | no | – | Discord ID of the fake user |

\* Required for real Discord login; not needed in fake mode.

## Endpoints

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/health` | – | `{ ok, service, version }` |
| GET | `/api/v1/auth/discord/start?redirect_uri=` | – | 302 to Discord (or fake login) |
| GET | `/api/v1/auth/discord/callback` | – | OAuth callback, 302 to the app with `?code=` |
| POST | `/api/v1/auth/device/exchange` | – | `{ code, redirect_uri, device }` → tokens |
| POST | `/api/v1/auth/device/refresh` | – | `{ refreshToken }` → new tokens (rotation) |
| POST | `/api/v1/auth/device/logout` | Bearer | sign out the current device |
| GET | `/api/v1/me` | Bearer (even pending) | `{ user, device }` |
| GET | `/api/v1/devices` | Bearer (approved) | own devices |
| DELETE | `/api/v1/devices/:deviceId` | Bearer (approved) | revoke own device |
| GET | `/api/v1/admin/users?status=` | Admin | user list |
| POST | `/api/v1/admin/users/:discordId/approve` | Admin | approve |
| POST | `/api/v1/admin/users/:discordId/lock` | Admin | lock + revoke all devices |
| POST | `/api/v1/admin/users/:discordId/role` | Admin | `{ role: "admin"\|"member" }` |
| GET | `/api/v1/internal/ping` | `x-fg-service-token` | service-to-service probe |
| GET | `/api/v1/packs/:packId/workspace` | Member+ | authoritative live snapshot + version |
| POST | `/api/v1/packs/:packId/workspace/initialize` | Editor+ | initialize the durable collaboration head |
| POST | `/api/v1/packs/:packId/workspace/operations` | Editor+ | atomic idempotent field/entity/batch operation |
| POST | `/api/v1/packs/:packId/builds` | Editor+ | `{ revision: n\|"head" }` → 202 (build running) or 200 (cache) |
| GET | `/api/v1/builds/:buildId` | Member+ | build status `{ queued\|running\|done\|error }` |
| GET | `/api/v1/builds/:buildId/artifact` | Member+ | artifact ZIP (FiveM resource, without YMTs, see above) |
| POST | `/api/v1/packs/:packId/publish` | Owner | `{ visibility, targets, revision }` → registry listing |
| GET | `/api/v1/registry/packs?target=&q=&page=&pageSize=` | `x-fg-service-token` | published packs (community) |
| GET | `/api/v1/registry/packs/:idOrSlug` | `x-fg-service-token` | pack + published revision manifest |
| GET | `/api/v1/registry/packs/:idOrSlug/download` | `x-fg-service-token` | build ZIP (202 `{ build }` while building) |
| POST | `/api/v1/import/creative/:creativeProjectId` | Admin | one-shot import of a creative cloth pack → pack + revision 1 |

> The `/admin` web dashboard and its `/api/v1/admin/web/*` JSON API use a
> separate cookie session — see [Admin dashboard](#admin-dashboard-web).

### Server builds & registry

- Builds are **cached per `{ packId, revision }`** (revisions are immutable):
  the first `POST /builds` → `202` + queue (`ATELIER_BUILD_CONCURRENCY`),
  finished builds → `200` with a cache hit. Artifacts:
  `<ATELIER_STORAGE_ROOT>/builds/<packId>/<revision>.zip`.
- Status transitions are broadcast as `{ type: "build-status", buildId, status }`
  into the pack's WebSocket room; completions land as `build.completed` in the
  activity log.
- **Split semantics** (1:1 mirror of the sidecar `BuildPlanner`): per gender the
  ADDON drawables are split, in revision order, into flat `splitAt` chunks
  (default 128, the YMT limit); part k = chunk k of both genders, and with >1
  part EVERY part gets the suffix `_partN` on both the resource folder AND the
  dlcName. `NNN` = index within the `(part, gender, slot)` bucket (restarts at
  000 per part). Replace drawables go without a DLC prefix into part 1
  (`NNN` = `replaceTargetId`), never into a YMT/shop meta. Props keep their `p_`
  slot prefix in the stream name. Shop metas: one gender → `shop_ped_apparel.meta`,
  both → `shop_ped_apparel_m.meta` + `shop_ped_apparel_f.meta`. Stream names,
  shop metas and `fxmanifest.lua` are **byte-identical** to the desktop build
  (verified via an integration diff) — only the YMTs (missing server-side),
  `atelier-build.json` and `ATELIER_README.txt` differ.
- **Creative import:** componentId→slot follows creative's own semantics
  (`7=accs`, `8=teef` — swapped in creative vs. the canonical order, `5=hand`
  also for "task" files), so imported packs keep exactly the slot the creative
  UI showed. Gender: male, unless `scope.pedGender == "female"`. Missing files →
  `skipped[]`.

## Running

```bash
bun install
cp .env.example .env.local   # fill in the values
bun run dev                  # with --watch
bun run start                # without watch
bun run lint                 # tsc --noEmit
bun run selftest:live        # pure live reducer/validator checks
bun run smoke                # E2E test (server must be running, fake mode active)
bun run sync-roundtrip       # push/pull roundtrip like the app does it
```

## curl examples

```bash
# Health
curl http://127.0.0.1:3095/health

# 1) Start login (fake mode: immediate 302 with a code; otherwise 302 to Discord)
curl -i "http://127.0.0.1:3095/api/v1/auth/discord/start?redirect_uri=http://127.0.0.1:53682/callback"
# -> Location: http://127.0.0.1:53682/callback?code=<32hex>

# 2) Exchange the code for tokens
curl -X POST http://127.0.0.1:3095/api/v1/auth/device/exchange \
  -H 'content-type: application/json' \
  -d '{"code":"<32hex>","redirect_uri":"http://127.0.0.1:53682/callback","device":{"name":"My PC","platform":"windows","appVersion":"0.1.0"}}'

# 3) Authenticated requests
curl http://127.0.0.1:3095/api/v1/me -H "authorization: Bearer <accessToken>"
curl http://127.0.0.1:3095/api/v1/devices -H "authorization: Bearer <accessToken>"

# 4) Refresh the access token (the refresh token ROTATES!)
curl -X POST http://127.0.0.1:3095/api/v1/auth/device/refresh \
  -H 'content-type: application/json' \
  -d '{"refreshToken":"<96hex>"}'

# 5) Admin: approve a pending user
curl http://127.0.0.1:3095/api/v1/admin/users?status=pending -H "authorization: Bearer <adminToken>"
curl -X POST http://127.0.0.1:3095/api/v1/admin/users/<discordId>/approve -H "authorization: Bearer <adminToken>"

# 6) Service-to-service
curl http://127.0.0.1:3095/api/v1/internal/ping -H "x-fg-service-token: <ATELIER_SERVICE_TOKEN>"
```

## Setting up a Discord app

1. <https://discord.com/developers/applications> → **New Application** → name e.g. `atelier`.
2. Open **OAuth2** on the left.
3. Copy the **Client ID** → `ATELIER_DISCORD_CLIENT_ID`.
4. **Reset Secret** → copy the **Client Secret** → `ATELIER_DISCORD_CLIENT_SECRET`.
5. Under **Redirects** add exactly (BOTH):
   - `{ATELIER_PUBLIC_ORIGIN}/api/v1/auth/discord/callback` — desktop app login
   - `{ATELIER_PUBLIC_ORIGIN}/admin/callback` — web admin dashboard
   (locally that's `http://127.0.0.1:3095/api/v1/auth/discord/callback`
   and `http://127.0.0.1:3095/admin/callback`).
6. Scope `identify` is enough — it is requested automatically by the service.
7. Set `ATELIER_DEV_FAKE_AUTH=0` (once real creds exist, fake mode disables
   itself anyway).

## Admin dashboard (web)

A browser dashboard at **`{ATELIER_PUBLIC_ORIGIN}/admin`** — login only for
Discord IDs in `ATELIER_ADMIN_DISCORD_IDS` (a separate Discord web login, decoupled
from the desktop loopback flow; signed HttpOnly session cookie, 12 h, admin check
on every request). It offers:

- **Overview** — storage size (CAS/builds/tmp) + metrics (assets, packs,
  revisions, builds, users).
- **Logs** — live server logs (SSE) + activity audit (`atelierActivity`).
- **Packs & builds** — create/rebuild a server build per revision, download
  finished packages as **ZIP**.
- **fxmanifest & build config** — a per-pack resource-name and `fxmanifest.lua`
  template override (placeholders `{{files}}` / `{{data_files}}`); affects server
  builds only and takes effect on the next build. Without an override the manifest
  stays byte-identical to the desktop build.
- **Users** — approve / lock.

Requirement: real Discord creds + the `/admin/callback` redirect URI (see above).
Locally with fake auth, `/admin/login` logs in directly as
`ATELIER_DEV_FAKE_DISCORD_ID` (which must be in `ATELIER_ADMIN_DISCORD_IDS`).

### Admin routes

Browser pages (cookie session, gated on `ATELIER_ADMIN_DISCORD_IDS`):

| Method | Path | Description |
| --- | --- | --- |
| GET | `/admin` | login page, or the dashboard when signed in |
| GET | `/admin/login` | → Discord OAuth (or the dev fake login) |
| GET | `/admin/callback` | Discord callback; sets the session cookie |
| GET | `/admin/logout` | clears the session |
| GET | `/admin/app.css`, `/admin/app.js` | static dashboard assets |

JSON API — all under `/api/v1/admin/web/`, cookie-authed; mutations also require a
same-origin request:

| Method | Path | Description |
| --- | --- | --- |
| GET | `…/overview` | version, uptime, storage stats, counts |
| GET | `…/activity?limit=` | activity audit log (`atelierActivity`) |
| GET | `…/logs` | server-log ring-buffer snapshot |
| GET | `…/logs/stream` | live server logs (SSE) |
| GET | `…/packs` | pack list |
| GET | `…/packs/:packId` | pack detail (revisions, builds, build config) |
| POST | `…/packs/:packId/builds` | `{ revision, force? }` → trigger/rebuild a server build |
| PUT | `…/packs/:packId/build-config` | `{ resourceName, fxmanifestTemplate }` → fxmanifest override |
| GET | `…/builds` | all server builds |
| GET | `…/builds/:buildId/download` | artifact ZIP |
| GET / POST | `…/users` · `…/users/:discordId/approve` · `…/users/:discordId/lock` | user management |

## Docker & CI

- **Docker:** `docker build -t atelier-api .` — image on `oven/bun:1`, CAS
  storage as a volume under `/data` (`ATELIER_STORAGE_ROOT`), health check on
  `GET /health`, runs as an unprivileged `bun` user. Behind a reverse proxy set
  `ATELIER_TRUST_PROXY=1`. Example:

  ```sh
  docker build -t atelier-api .
  docker run -d --name atelier-api \
    -p 3095:3095 \
    -v atelier-data:/data \
    --env-file .env.docker \
    atelier-api
  ```

- **CI** (`.github/workflows/ci.yml`, PRs + master + tags): typecheck, then the
  full smoke suite (120 checks) + sync roundtrip (15 checks) against a live-started
  server with dev fake auth and a `mongo:7` service container, plus `docker build`
  as a pure Dockerfile gate. No image is pushed to a registry on purpose — the
  deployment builds the image directly on the target host from the repo.

## License

atelier-api is released under the **[PolyForm Noncommercial License 1.0.0](LICENSE.md)**:
using, modifying and sharing for **noncommercial** purposes is allowed — **selling
and commercial use are not permitted** (please keep the copyright notice from the
license intact). Part of [atelier](https://github.com/feelgoodrp-com/atelier).
Dependencies (Bun, the MongoDB driver, JSZip) are under their respective licenses.

## Credits

In the spirit of [grzyClothTool](https://github.com/grzybeek/grzyClothTool)
(grzybeek), with [CodeWalker](https://github.com/dexyfex/CodeWalker) (dexyfex) for
the build pipeline. Built by the **feelgood team**.
