import assert from "node:assert/strict";
import {
  edgeCacheKey,
  KvTranslationEdgeCache,
} from "./translationEdgeCache.ts";

Deno.test("KV translation cache uses versioned composite keys and expiry", async () => {
  let writtenKey = "";
  let writtenValue = "";
  let expirationTtl = 0;
  const cache = new KvTranslationEdgeCache(
    {
      get: () => Promise.resolve(undefined),
      put: (key, value, options) => {
        writtenKey = key;
        writtenValue = value;
        expirationTtl = options?.expirationTtl ?? 0;
        return Promise.resolve();
      },
    },
    () => Date.parse("2026-08-05T00:00:00.000Z"),
  );
  await cache.put({
    locale: "zh-CN",
    type: "modrinth",
    projectId: "project",
    content: "translation",
    contentType: "text/markdown",
    sourceHash: "hash",
    updatedAt: "2026-08-05T00:00:00.000Z",
    validUntil: "2026-08-06T00:00:00.000Z",
  });
  assert.equal(writtenKey, "v1:zh-CN:modrinth:project");
  assert.equal(expirationTtl, 24 * 60 * 60);
  assert.equal(JSON.parse(writtenValue).version, 1);
});

Deno.test("KV translation cache rejects mismatched payload keys", async () => {
  const cache = new KvTranslationEdgeCache({
    get: () =>
      Promise.resolve({
        version: 1,
        locale: "ja",
        type: "curseforge",
        projectId: "project",
        content: "wrong provider",
        contentType: "text/html",
        updatedAt: "2026-08-05T00:00:00.000Z",
        validUntil: "2099-08-05T00:00:00.000Z",
      }),
    put: () => Promise.resolve(),
  });
  assert.equal(
    await cache.get({
      locale: "ja",
      type: "modrinth",
      projectId: "project",
    }),
    undefined,
  );
  assert.equal(
    edgeCacheKey({
      locale: "ja",
      type: "modrinth",
      projectId: "project",
    }),
    "v1:ja:modrinth:project",
  );
});
