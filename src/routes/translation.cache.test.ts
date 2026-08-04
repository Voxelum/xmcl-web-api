import assert from "node:assert/strict";
import { createApp } from "../app.ts";
import type { Db, MongoCollection } from "../db.ts";
import { getHasher } from "../lib/hasher.ts";

Deno.test("translation negatively caches missing community files", async () => {
  const source = "Fresh source description";
  const bodyHash = (await getHasher())(source);
  const collection: MongoCollection = {
    findOne: () =>
      Promise.resolve({
        _id: "negative-cache-project",
        bodyHash,
        content: "Cached translation",
      }),
    updateOne: () => Promise.resolve({ modifiedCount: 1 }),
    replaceOne: () => Promise.resolve({ matchedCount: 1 }),
    deleteOne: () => Promise.resolve({ deletedCount: 1 }),
  };
  const db: Db = { collection: () => collection };
  const app = createApp((registered) => {
    registered.use("*", async (c, next) => {
      c.set("getDb", async () => db);
      await next();
    });
  });
  const original = globalThis.fetch;
  let sourceCalls = 0;
  let i18nCalls = 0;
  globalThis.fetch = (input: Request | URL | string) => {
    const url = new URL(
      input instanceof URL
        ? input
        : typeof input === "string"
        ? input
        : input.url,
    );
    if (url.hostname === "api.modrinth.com") {
      sourceCalls += 1;
      return Promise.resolve(Response.json({ body: source }));
    }
    if (url.hostname === "raw.githubusercontent.com") {
      i18nCalls += 1;
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    throw new Error(`Unexpected fetch ${url}`);
  };

  try {
    const request = () =>
      app.request(
        "/translation?type=modrinth&id=negative-cache-project",
        { headers: { "accept-language": "fr" } },
      );
    assert.equal((await request()).status, 200);
    assert.equal((await request()).status, 200);
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(sourceCalls, 2);
  assert.equal(i18nCalls, 1);
});
