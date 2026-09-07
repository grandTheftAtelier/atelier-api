/**
 * OpenAPI 3.1 description of the atelier-api HTTP surface, authored as a typed
 * object (no framework, no build step — same spirit as the rest of the code).
 *
 * Served at GET /openapi.json and rendered by GET /docs. Feed the JSON to
 * `openapi-typescript` to generate a typed client (see README → "OpenAPI").
 *
 * It is intentionally hand-curated: the goal is an accurate, readable contract
 * for the endpoints consumers actually call, not an exhaustive field dump.
 */

import pkg from "../package.json";

const err = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

const jsonResp = (description: string, schema: object) => ({
  description,
  content: { "application/json": { schema } },
});

export function buildOpenApiSpec(publicOrigin: string): object {
  return {
    openapi: "3.1.0",
    info: {
      title: "atelier-api",
      version: pkg.version,
      description:
        "Backend for the atelier desktop app: Discord login, device tokens, user approval, " +
        "content-addressed uploads, packs/revisions, realtime collaboration, server builds and " +
        "a community registry. Error convention: `{ \"error\": \"code\" }`.",
      license: { name: "PolyForm Noncommercial 1.0.0" },
    },
    servers: [{ url: publicOrigin }],
    tags: [
      { name: "Health", description: "Liveness, readiness and version." },
      { name: "Auth", description: "Discord OAuth + device token exchange/refresh." },
      { name: "Devices", description: "The signed-in user's devices." },
      { name: "Me", description: "The current user." },
      { name: "Admin", description: "User management (device-token admin lane)." },
      { name: "Uploads", description: "Resumable chunk uploads into the CAS." },
      { name: "Assets", description: "CAS asset presence + download." },
      { name: "Packs", description: "Packs, workspaces and publish." },
      { name: "Builds", description: "Server builds and artifacts." },
      { name: "Registry", description: "Published packs for community sites (service lane)." },
      { name: "Import", description: "One-shot import from creative." },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT",
          description: "Device access token from /auth/device/exchange (1 h, HS256)." },
        serviceToken: { type: "apiKey", in: "header", name: "x-fg-service-token",
          description: "Shared service-to-service token (ATELIER_SERVICE_TOKEN)." },
        adminCookie: { type: "apiKey", in: "cookie", name: "atelier_admin",
          description: "Web admin dashboard session cookie (set by /admin/callback)." },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: { error: { type: "string", description: "Machine-readable error code." },
            params: { type: "object", additionalProperties: true } },
        },
        HealthLive: {
          type: "object",
          properties: {
            ok: { type: "boolean", const: true },
            service: { type: "string" }, version: { type: "string" },
            mongo: { type: "boolean", description: "Cached MongoDB reachability." },
            updateAvailable: { type: "boolean" }, latestVersion: { type: ["string", "null"] },
          },
        },
        HealthReady: {
          type: "object",
          properties: { ok: { type: "boolean" }, service: { type: "string" },
            version: { type: "string" }, mongo: { type: "boolean" } },
        },
        VersionStatus: {
          type: "object",
          properties: { current: { type: "string" }, latest: { type: ["string", "null"] },
            updateAvailable: { type: "boolean" }, checkedAt: { type: ["string", "null"], format: "date-time" } },
        },
        PublicUser: {
          type: "object",
          properties: {
            discordId: { type: "string" }, username: { type: "string" },
            avatar: { type: ["string", "null"] },
            status: { type: "string", enum: ["pending", "approved", "locked"] },
            role: { type: "string", enum: ["admin", "member"] },
          },
        },
        Device: {
          type: "object",
          properties: {
            deviceId: { type: "string" }, name: { type: "string" },
            platform: { type: "string" }, appVersion: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
            lastSeenAt: { type: "string", format: "date-time" },
          },
        },
        TokenBundle: {
          type: "object",
          properties: {
            accessToken: { type: "string", description: "JWT, 1 h." },
            refreshToken: { type: "string", description: "Opaque, 90 d, rotates on every refresh." },
            user: { $ref: "#/components/schemas/PublicUser" },
          },
        },
        Build: {
          type: "object",
          properties: {
            buildId: { type: "string" }, revision: { type: "integer" },
            status: { type: "string", enum: ["queued", "running", "done", "error"] },
            sizeBytes: { type: ["integer", "null"] }, error: { type: ["string", "null"] },
          },
        },
        RegistryPack: {
          type: "object",
          properties: {
            packId: { type: "string" }, slug: { type: "string" }, name: { type: "string" },
            publishedRevision: { type: ["integer", "null"] },
            visibility: { type: "string", enum: ["public", "unlisted"] },
            targets: { type: "array", items: { type: "string" } },
          },
        },
        StorageStats: {
          type: "object",
          properties: {
            root: { type: "string" }, totalBytes: { type: "integer" },
            cas: { $ref: "#/components/schemas/DirUsage" },
            builds: { $ref: "#/components/schemas/DirUsage" },
            tmp: { $ref: "#/components/schemas/DirUsage" },
          },
        },
        DirUsage: {
          type: "object",
          properties: { files: { type: "integer" }, bytes: { type: "integer" } },
        },
        GcReport: {
          type: "object",
          description: "Storage garbage-collection preview (dry run) or result.",
          properties: {
            dryRun: { type: "boolean" }, graceHours: { type: "integer" },
            orphanAssets: { $ref: "#/components/schemas/GcCategory" },
            staleTmp: { $ref: "#/components/schemas/GcCategory" },
            orphanBuilds: { $ref: "#/components/schemas/GcCategory" },
            totalCount: { type: "integer" }, totalBytes: { type: "integer" },
          },
        },
        GcCategory: {
          type: "object",
          properties: { count: { type: "integer" }, bytes: { type: "integer" } },
        },
      },
    },
    paths: {
      "/health": {
        get: {
          tags: ["Health"], summary: "Liveness probe (always 200 while the process is up).",
          responses: { "200": jsonResp("Service is up.", { $ref: "#/components/schemas/HealthLive" }) },
        },
      },
      "/health/ready": {
        get: {
          tags: ["Health"], summary: "Readiness probe — 200 only when MongoDB is reachable, else 503.",
          responses: {
            "200": jsonResp("Ready.", { $ref: "#/components/schemas/HealthReady" }),
            "503": jsonResp("Not ready (MongoDB unreachable).", { $ref: "#/components/schemas/HealthReady" }),
          },
        },
      },
      "/api/v1/version": {
        get: {
          tags: ["Health"], summary: "Server version + update-available status.",
          parameters: [{ name: "refresh", in: "query", schema: { type: "string", enum: ["1"] },
            description: "Force a fresh upstream check." }],
          responses: { "200": jsonResp("Version status.", { $ref: "#/components/schemas/VersionStatus" }) },
        },
      },
      "/api/v1/auth/discord/start": {
        get: {
          tags: ["Auth"], summary: "Begin Discord login; 302 to Discord (or the dev fake login).",
          parameters: [{ name: "redirect_uri", in: "query", required: true,
            schema: { type: "string" }, description: "Loopback callback in the desktop app." }],
          responses: { "302": { description: "Redirect to Discord / back to the app with ?code=." } },
        },
      },
      "/api/v1/auth/discord/callback": {
        get: {
          tags: ["Auth"], summary: "Discord OAuth callback; 302 back to the app with a one-time code.",
          responses: { "302": { description: "Redirect to the app redirect_uri with ?code=." } },
        },
      },
      "/api/v1/auth/device/exchange": {
        post: {
          tags: ["Auth"], summary: "Exchange a one-time code for a token bundle.",
          requestBody: { required: true, content: { "application/json": { schema: {
            type: "object", required: ["code", "redirect_uri", "device"],
            properties: { code: { type: "string" }, redirect_uri: { type: "string" },
              device: { type: "object", properties: { name: { type: "string" },
                platform: { type: "string" }, appVersion: { type: "string" } } } } } } } },
          responses: {
            "200": jsonResp("Token bundle.", { $ref: "#/components/schemas/TokenBundle" }),
            "400": err("Invalid or expired code."), "429": err("Rate limited."),
          },
        },
      },
      "/api/v1/auth/device/refresh": {
        post: {
          tags: ["Auth"], summary: "Rotate the refresh token and mint a new access token.",
          requestBody: { required: true, content: { "application/json": { schema: {
            type: "object", required: ["refreshToken"],
            properties: { refreshToken: { type: "string" } } } } } },
          responses: {
            "200": jsonResp("New token bundle (refresh token rotated).", { $ref: "#/components/schemas/TokenBundle" }),
            "401": err("Invalid/rotated refresh token."), "429": err("Rate limited."),
          },
        },
      },
      "/api/v1/auth/device/logout": {
        post: { tags: ["Auth"], summary: "Sign out the current device.", security: [{ bearerAuth: [] }],
          responses: { "200": jsonResp("Signed out.", { type: "object", properties: { ok: { type: "boolean" } } }) } },
      },
      "/api/v1/me": {
        get: { tags: ["Me"], summary: "Current user + device (works even while pending).",
          security: [{ bearerAuth: [] }],
          responses: { "200": jsonResp("Current identity.", { type: "object", properties: {
            user: { $ref: "#/components/schemas/PublicUser" }, device: { $ref: "#/components/schemas/Device" } } }),
            "401": err("Missing/invalid token.") } },
      },
      "/api/v1/devices": {
        get: { tags: ["Devices"], summary: "List the user's devices.", security: [{ bearerAuth: [] }],
          responses: { "200": jsonResp("Devices.", { type: "object", properties: {
            devices: { type: "array", items: { $ref: "#/components/schemas/Device" } } } }) } },
      },
      "/api/v1/devices/{deviceId}": {
        delete: { tags: ["Devices"], summary: "Revoke one of the user's devices.", security: [{ bearerAuth: [] }],
          parameters: [{ name: "deviceId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": jsonResp("Revoked.", { type: "object", properties: { ok: { type: "boolean" } } }),
            "404": err("Not found.") } },
      },
      "/api/v1/admin/users": {
        get: { tags: ["Admin"], summary: "List users, optionally by status.", security: [{ bearerAuth: [] }],
          parameters: [{ name: "status", in: "query",
            schema: { type: "string", enum: ["pending", "approved", "locked"] } }],
          responses: { "200": jsonResp("Users.", { type: "object", properties: {
            users: { type: "array", items: { $ref: "#/components/schemas/PublicUser" } } } }) } },
      },
      "/api/v1/admin/users/{discordId}/approve": {
        post: { tags: ["Admin"], summary: "Approve a pending user.", security: [{ bearerAuth: [] }],
          parameters: [{ name: "discordId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": jsonResp("Approved.", { $ref: "#/components/schemas/PublicUser" }) } },
      },
      "/api/v1/admin/users/{discordId}/lock": {
        post: { tags: ["Admin"], summary: "Lock a user and revoke all their devices.", security: [{ bearerAuth: [] }],
          parameters: [{ name: "discordId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": jsonResp("Locked.", { $ref: "#/components/schemas/PublicUser" }) } },
      },
      "/api/v1/admin/users/{discordId}/role": {
        post: { tags: ["Admin"], summary: "Set a user's role.", security: [{ bearerAuth: [] }],
          parameters: [{ name: "discordId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: {
            type: "object", required: ["role"], properties: { role: { type: "string", enum: ["admin", "member"] } } } } } },
          responses: { "200": jsonResp("Updated.", { $ref: "#/components/schemas/PublicUser" }) } },
      },
      "/api/v1/packs/{packId}/workspace": {
        get: { tags: ["Packs"], summary: "Authoritative live workspace snapshot + version.",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "packId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": jsonResp("Workspace snapshot.", { type: "object" }), "403": err("Not a member.") } },
      },
      "/api/v1/packs/{packId}/workspace/operations": {
        post: { tags: ["Packs"], summary: "Apply an atomic, idempotent workspace operation.",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "packId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": jsonResp("Applied (or replayed).", { type: "object" }), "409": err("Version conflict.") } },
      },
      "/api/v1/packs/{packId}/builds": {
        post: { tags: ["Builds"], summary: "Build a revision (202 building, 200 cache hit).",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "packId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: {
            type: "object", properties: { revision: { oneOf: [{ type: "integer" }, { type: "string", enum: ["head"] }] } } } } } },
          responses: {
            "200": jsonResp("Cache hit.", { type: "object", properties: { build: { $ref: "#/components/schemas/Build" } } }),
            "202": jsonResp("Build queued/running.", { type: "object", properties: { build: { $ref: "#/components/schemas/Build" } } }),
          } },
      },
      "/api/v1/builds/{buildId}": {
        get: { tags: ["Builds"], summary: "Build status.", security: [{ bearerAuth: [] }],
          parameters: [{ name: "buildId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": jsonResp("Status.", { $ref: "#/components/schemas/Build" }), "404": err("Not found.") } },
      },
      "/api/v1/builds/{buildId}/artifact": {
        get: { tags: ["Builds"], summary: "Download the built FiveM resource ZIP (without YMTs).",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "buildId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "ZIP stream.", content: { "application/zip": {} } },
            "409": err("Build not done.") } },
      },
      "/api/v1/packs/{packId}/publish": {
        post: { tags: ["Packs"], summary: "Publish a revision to the registry.", security: [{ bearerAuth: [] }],
          parameters: [{ name: "packId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: {
            type: "object", properties: { visibility: { type: "string", enum: ["public", "unlisted"] },
              targets: { type: "array", items: { type: "string" } },
              revision: { oneOf: [{ type: "integer" }, { type: "string", enum: ["head"] }] } } } } } },
          responses: { "200": jsonResp("Registry listing.", { $ref: "#/components/schemas/RegistryPack" }) } },
      },
      "/api/v1/registry/packs": {
        get: { tags: ["Registry"], summary: "List published packs.", security: [{ serviceToken: [] }],
          parameters: [
            { name: "target", in: "query", schema: { type: "string" } },
            { name: "q", in: "query", schema: { type: "string" } },
            { name: "page", in: "query", schema: { type: "integer" } },
            { name: "pageSize", in: "query", schema: { type: "integer" } },
          ],
          responses: { "200": jsonResp("Published packs.", { type: "object", properties: {
            packs: { type: "array", items: { $ref: "#/components/schemas/RegistryPack" } } } }) } },
      },
      "/api/v1/registry/packs/{idOrSlug}": {
        get: { tags: ["Registry"], summary: "Pack + published revision manifest.", security: [{ serviceToken: [] }],
          parameters: [{ name: "idOrSlug", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": jsonResp("Pack manifest.", { $ref: "#/components/schemas/RegistryPack" }),
            "404": err("Not found.") } },
      },
      "/api/v1/registry/packs/{idOrSlug}/download": {
        get: { tags: ["Registry"], summary: "Download the build ZIP (202 while building).",
          security: [{ serviceToken: [] }],
          parameters: [{ name: "idOrSlug", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "ZIP stream.", content: { "application/zip": {} } },
            "202": jsonResp("Building.", { type: "object", properties: { build: { $ref: "#/components/schemas/Build" } } }) } },
      },
      "/api/v1/import/creative/{creativeProjectId}": {
        post: { tags: ["Import"], summary: "One-shot import of a creative cloth pack → pack + revision 1.",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "creativeProjectId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": jsonResp("Imported.", { type: "object" }), "503": err("Creative import not configured.") } },
      },
      "/api/v1/internal/ping": {
        get: { tags: ["Health"], summary: "Service-to-service probe.", security: [{ serviceToken: [] }],
          responses: { "200": jsonResp("OK.", { type: "object", properties: { ok: { type: "boolean" } } }),
            "401": err("Bad service token.") } },
      },
      "/api/v1/admin/web/storage/gc": {
        get: { tags: ["Admin"], summary: "Preview reclaimable storage (dry run).", security: [{ adminCookie: [] }],
          responses: { "200": jsonResp("What a cleanup would reclaim.", { $ref: "#/components/schemas/GcReport" }) } },
        post: { tags: ["Admin"], summary: "Run storage cleanup.", security: [{ adminCookie: [] }],
          requestBody: { content: { "application/json": { schema: {
            type: "object", properties: { graceHours: { type: "number", minimum: 1 } } } } } },
          responses: { "200": jsonResp("What was reclaimed.", { $ref: "#/components/schemas/GcReport" }) } },
      },
      "/api/v1/admin/web/overview": {
        get: { tags: ["Admin"], summary: "Dashboard overview (version, storage, counts, notifier status).",
          security: [{ adminCookie: [] }],
          responses: { "200": jsonResp("Overview.", { type: "object", properties: {
            version: { type: "string" }, uptimeSec: { type: "integer" },
            notifierConfigured: { type: "boolean" },
            storage: { $ref: "#/components/schemas/StorageStats" }, counts: { type: "object" } } }) } },
      },
    },
  };
}
