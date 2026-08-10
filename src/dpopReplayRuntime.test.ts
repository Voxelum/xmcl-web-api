import assert from "node:assert/strict";
import {
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

Deno.test("Mongo DPoP replay store consumes a jti once", async () => {
  let current: { _id: string; expiresAt: Date } | undefined;
  const collection = {
    createIndex: () => Promise.resolve("dpop_replay_expiry"),
    replaceOne(
      filter: Record<string, unknown>,
      replacement: Record<string, unknown>,
    ) {
      const expiresBefore = (filter.expiresAt as { $lte: Date }).$lte;
      if (current && current.expiresAt > expiresBefore) {
        return Promise.reject({ code: 11_000 });
      }
      current = replacement as typeof current;
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
