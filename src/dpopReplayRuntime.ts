import type { Context } from "hono";
import { createCloudflareDpopReplayStore } from "./cloudflare/dpopReplay.ts";
import type { Db, MongoCollection } from "./db.ts";
import type { DpopReplayStore } from "./dpop.ts";
import type { AppEnv } from "./types.ts";

let mongoIndexReady: Promise<void> | undefined;

export async function resolveDpopReplayStore(
  c: Context<AppEnv>,
): Promise<DpopReplayStore | undefined> {
  if (c.env?.DPOP_REPLAY) {
    return createCloudflareDpopReplayStore(c.env.DPOP_REPLAY);
  }
  const getDb = c.get("getDb");
  if (!getDb) return undefined;
  return createMongoDpopReplayStore(await getDb());
}

export function requiresSharedDpopReplay(method: string, requestUrl: string) {
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    return true;
  }
  const path = new URL(requestUrl).pathname;
  return path === "/v1/rtc/official" ||
    path.startsWith("/v1/multiplayer/");
}

export function createMongoDpopReplayStore(db: Db): DpopReplayStore {
  const collection = db.collection("xmcl_dpop_replays");
  return {
    async consume(key, expiresAt) {
      await ensureMongoTtlIndex(collection);
      try {
        await collection.replaceOne(
          {
            _id: key,
            expiresAt: { $lte: new Date() },
          },
          {
            _id: key,
            expiresAt: new Date(expiresAt),
          },
          { upsert: true },
        );
        return true;
      } catch (error) {
        if (isDuplicateKey(error)) return false;
        throw error;
      }
    },
  };
}

async function ensureMongoTtlIndex(collection: MongoCollection) {
  if (!collection.createIndex) return;
  mongoIndexReady ??= collection.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, name: "dpop_replay_expiry" },
  ).then(() => undefined).catch((error) => {
    mongoIndexReady = undefined;
    throw error;
  });
  await mongoIndexReady;
}

function isDuplicateKey(error: unknown) {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === 11_000;
}
