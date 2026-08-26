/**
 * Lazy MongoDB singleton (raw driver, no ORM).
 * configureMongo(env) once at startup, then getDb() everywhere.
 */

import { setServers } from "node:dns";
import { MongoClient, type Db, type Document, type Collection } from "mongodb";
import type { Env } from "./env";

let configured: Env | null = null;
let client: MongoClient | null = null;
let dbPromise: Promise<Db> | null = null;

export function configureMongo(env: Env): void {
  configured = env;
}

export function getDb(): Promise<Db> {
  if (!configured) throw new Error("configureMongo(env) must be called before getDb()");
  if (!dbPromise) {
    const env = configured;
    dbPromise = (async () => {
      // Workaround: Bun on Windows can fail SRV lookups (mongodb+srv://) against
      // some system resolvers. MONGODB_DNS_SERVERS=8.8.8.8 forces a working one.
      if (env.MONGODB_DNS_SERVERS.length > 0) {
        try {
          setServers(env.MONGODB_DNS_SERVERS);
        } catch (e) {
          console.warn("[atelier-api] dns.setServers failed:", e);
        }
      }
      client = new MongoClient(env.MONGODB_URI, {
        serverSelectionTimeoutMS: 10_000,
      });
      await client.connect();
      return client.db(env.MONGODB_DB_NAME);
    })().catch((e) => {
      // Reset so a later request can retry the connection.
      dbPromise = null;
      client = null;
      throw e;
    });
  }
  return dbPromise;
}

export async function col<T extends Document>(name: string): Promise<Collection<T>> {
  const db = await getDb();
  return db.collection<T>(name);
}

/** Quick connectivity probe for /health style checks. */
export async function pingMongo(): Promise<boolean> {
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure all indexes at startup:
 * - atelierUsers.discordId unique
 * - atelierAuthCodes: TTL on expiresAt, unique code
 * - atelierDevices.deviceId unique (+ lookup helpers, TTL on refreshExpiresAt)
 * - atelierActivity.ts
 * - atelierAssets.sha256 unique
 * - atelierUploads: uploadId unique, per-user session lookup, TTL on expiresAt
 * - atelierPacks: packId unique, slug unique among non-archived, member lookups
 * - atelierRevisions: { packId, revision } unique
 * - atelierWorkspaces: packId unique (one live collaboration head per pack)
 * - atelierWorkspaceOperations: permanent operation-id dedupe per pack
 * - atelierLocks: { packId, drawableEntryId } unique, TTL on expiresAt
 */
export async function ensureIndexes(): Promise<void> {
  const db = await getDb();

  await db.collection("atelierUsers").createIndex({ discordId: 1 }, { unique: true });

  await db.collection("atelierAuthCodes").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection("atelierAuthCodes").createIndex({ code: 1 }, { unique: true });

  await db.collection("atelierDevices").createIndex({ deviceId: 1 }, { unique: true });
  await db.collection("atelierDevices").createIndex({ discordId: 1 });
  await db.collection("atelierDevices").createIndex({ refreshTokenHash: 1 });
  await db.collection("atelierDevices").createIndex({ previousRefreshTokenHash: 1 });
  // A device whose refresh token expired can never authenticate again — let Mongo clean it up.
  await db.collection("atelierDevices").createIndex({ refreshExpiresAt: 1 }, { expireAfterSeconds: 0 });

  await db.collection("atelierActivity").createIndex({ ts: -1 });

  await db.collection("atelierAssets").createIndex({ sha256: 1 }, { unique: true });

  await db.collection("atelierUploads").createIndex({ uploadId: 1 }, { unique: true });
  await db.collection("atelierUploads").createIndex({ sha256Expected: 1, createdByDiscordId: 1 });
  await db.collection("atelierUploads").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

  await db.collection("atelierPacks").createIndex({ packId: 1 }, { unique: true });
  // Slug must be unique among ACTIVE packs only ($type "null" instead of
  // { archivedAt: null } — plain null equality is not allowed in partial indexes).
  await db.collection("atelierPacks").createIndex(
    { slug: 1 },
    { unique: true, partialFilterExpression: { archivedAt: { $type: "null" } } },
  );
  await db.collection("atelierPacks").createIndex({ ownerDiscordId: 1 });
  await db.collection("atelierPacks").createIndex({ "members.discordId": 1 });

  await db.collection("atelierRevisions").createIndex({ packId: 1, revision: 1 }, { unique: true });

  await db.collection("atelierWorkspaces").createIndex({ packId: 1 }, { unique: true });
  await db.collection("atelierWorkspaceOperations").createIndex(
    { packId: 1, operationId: 1 },
    { unique: true },
  );

  // Builds are cached per immutable revision — one document per (packId, revision).
  await db.collection("atelierBuilds").createIndex({ buildId: 1 }, { unique: true });
  await db.collection("atelierBuilds").createIndex({ packId: 1, revision: 1 }, { unique: true });

  // TTL deletion lags up to ~60s — lock readers ALWAYS check expiresAt too.
  await db.collection("atelierLocks").createIndex({ packId: 1, drawableEntryId: 1 }, { unique: true });
  await db.collection("atelierLocks").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
}

export async function closeMongo(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    dbPromise = null;
  }
}
