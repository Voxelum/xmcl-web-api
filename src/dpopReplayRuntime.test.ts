import assert from "node:assert/strict";
import {
  createMongoDpopReplayTtlIndex,
  createMongoDpopReplayStore,
  requiresSharedDpopReplay,
} from "./dpopReplayRuntime.ts";
import type { Db, MongoCollection } from "./db.ts";

Deno.test("DPoP shared replay policy protects writes and realtime credentials", () => {
  assert.equal(
    requiresSharedDpopReplay("POST", "https://api.xmcl.app/v1/servers"),
    true,
  );
  assert.equal(
    requiresSharedDpopReplay(
      "GET",
      "https://signaling.xmcl.app/v1/rtc/official",
    ),
    true,
  );
  assert.equal(
    requiresSharedDpopReplay(
      "GET",
      "https://api.xmcl.app/v1/account",
    ),
    false,
  );
});

Deno.test("Mongo DPoP replay store uses Cosmos _ts TTL cleanup when required", async () => {
  const indexes: Array<{
    keys: Record<string, number>;
    options: Record<string, unknown>;
  }> = [];
  const collection = {
    createIndex(
      keys: Record<string, number>,
      options: Record<string, unknown>,
    ) {
      indexes.push({ keys, options });
      if ("expiresAt" in keys) {
        return Promise.reject({
          code: 2,
          codeName: "BadValue",
          message: "The 'expireAfterSeconds' option is supported on '_ts' field only.",
        });
      }
      return Promise.resolve("dpop_replay_expiry");
    },
    deleteOne: () => Promise.resolve({}),
    insertOne: () => Promise.resolve({}),
  } as unknown as MongoCollection;
  await createMongoDpopReplayTtlIndex(collection);
  assert.deepEqual(indexes, [
    {
      keys: { expiresAt: 1 },
      options: { expireAfterSeconds: 0, name: "dpop_replay_expiry" },
    },
    {
      keys: { _ts: 1 },
      options: { expireAfterSeconds: 300, name: "dpop_replay_expiry" },
    },
  ]);
});

Deno.test("Mongo DPoP replay store reuses an existing Cosmos _ts TTL index", async () => {
  const indexes: Record<string, number>[] = [];
  const collection = {
    createIndex(keys: Record<string, number>) {
      indexes.push(keys);
      if ("expiresAt" in keys) {
        return Promise.reject({
          code: 86,
          codeName: "IndexKeySpecsConflict",
        });
      }
      return Promise.resolve("dpop_replay_expiry");
    },
  } as unknown as MongoCollection;

  await createMongoDpopReplayTtlIndex(collection);
  assert.deepEqual(indexes, [{ expiresAt: 1 }, { _ts: 1 }]);
});

Deno.test("Mongo DPoP replay store consumes a jti once", async () => {
  let current: { _id: string; expiresAt: Date } | undefined;
  const collection = {
    createIndex: () => Promise.resolve("dpop_replay_expiry"),
    deleteOne(filter: Record<string, unknown>) {
      const expiresBefore = (filter.expiresAt as { $lte: Date }).$lte;
      if (current && current.expiresAt <= expiresBefore) current = undefined;
      return Promise.resolve({});
    },
    insertOne(document: Record<string, unknown>) {
      if (current) return Promise.reject({ code: 11_000 });
      current = {
        _id: String(document._id),
        expiresAt: document.expiresAt as Date,
      };
      return Promise.resolve({});
    },
  } as unknown as MongoCollection;
  const db = {
    collection: () => collection,
  } satisfies Db;
  const store = createMongoDpopReplayStore(db);

  assert.equal(await store.consume("jkt:jti", Date.now() + 60_000), true);
  assert.equal(await store.consume("jkt:jti", Date.now() + 60_000), false);
});
