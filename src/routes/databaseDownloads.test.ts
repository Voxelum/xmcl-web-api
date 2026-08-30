import assert from "node:assert/strict";
import { createApp } from "../app.ts";

Deno.test("database downloads proxy only allow published database assets", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (input: Request | URL | string, init?: RequestInit) => {
    requests.push({
      url: input instanceof Request ? input.url : input.toString(),
      init,
    });
    return Promise.resolve(
      new Response("database", {
        status: 206,
        headers: {
          "accept-ranges": "bytes",
          "content-length": "8",
          "content-range": "bytes 0-7/8",
          "content-type": "application/octet-stream",
          "etag": '"database-etag"',
        },
      }),
    );
  };

  try {
    const app = createApp();
    const response = await app.request(
      "/downloads/databases/mod-metadata/db.sqlite",
      { headers: { range: "bytes=0-7", "if-none-match": '"old-etag"' } },
    );

    assert.equal(response.status, 206);
    assert.equal(await response.text(), "database");
    assert.equal(requests.length, 1);
    assert.equal(
      requests[0].url,
      "https://github.com/Voxelum/minecraft-mods-database/releases/latest/download/db.sqlite",
    );
    assert.equal(requests[0].init?.method, "GET");
    assert.equal(
      new Headers(requests[0].init?.headers).get("range"),
      "bytes=0-7",
    );
    assert.equal(
      new Headers(requests[0].init?.headers).get("if-none-match"),
      '"old-etag"',
    );
    assert.deepEqual(
      (requests[0].init as RequestInit & {
        cf: { cacheTtlByStatus: Record<string, number> };
      }).cf.cacheTtlByStatus,
      { "200-299": 3600, "404": 60, "500-599": 0 },
    );
    assert.equal(response.headers.get("content-range"), "bytes 0-7/8");
    assert.equal(response.headers.get("etag"), '"database-etag"');
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("database downloads preserve HEAD and reject arbitrary proxy targets", async () => {
  const requests: Array<{ url: string; method?: string }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (input: Request | URL | string, init?: RequestInit) => {
    requests.push({
      url: input instanceof Request ? input.url : input.toString(),
      method: init?.method,
    });
    return Promise.resolve(
      new Response(null, {
        headers: { "content-length": "64" },
      }),
    );
  };

  try {
    const app = createApp();
    const head = await app.request(
      "/downloads/databases/project-mapping/zh-cn.sqlite.sha256",
      { method: "HEAD" },
    );
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.deepEqual(requests, [{
      url:
        "https://github.com/Voxelum/xmcl-commuity-content-i18n/releases/latest/download/zh-cn.sqlite.sha256",
      method: "HEAD",
    }]);

    const arbitrary = await app.request(
      "/downloads/databases/project-mapping/..%2Fsecret",
    );
    assert.equal(arbitrary.status, 404);
    const wrongExtension = await app.request(
      "/downloads/databases/project-mapping/en.sqlite",
    );
    assert.equal(wrongExtension.status, 404);
    const wrongSource = await app.request(
      "/downloads/databases/other/db.sqlite",
    );
    assert.equal(wrongSource.status, 404);
    assert.equal(requests.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});
