import assert from "node:assert/strict";
import { createApp } from "../app.ts";

Deno.test("GitHub-backed public routes publish bounded cache behavior", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (input: Request | URL | string) => {
    const url = new URL(
      input instanceof URL
        ? input
        : typeof input === "string"
        ? input
        : input.url,
    );
    if (url.pathname.endsWith("/releases")) {
      return Promise.resolve(Response.json([{
        tag_name: "v1.0.0",
        prerelease: false,
        body: "Release notes",
        assets: [],
        draft: false,
      }]));
    }
    if (url.pathname.endsWith("/issues")) {
      return Promise.resolve(Response.json([]));
    }
    throw new Error(`Unexpected fetch ${url}`);
  };

  try {
    const app = createApp();
    const latest = await app.request("/latest");
    assert.equal(latest.status, 200);
    assert.equal(
      latest.headers.get("cache-control"),
      "public, max-age=300, stale-while-revalidate=86400",
    );
    assert.equal(latest.headers.get("vary"), "Accept-Language");

    const notifications = await app.request("/notifications");
    assert.equal(notifications.status, 200);
    assert.equal(
      notifications.headers.get("cache-control"),
      "public, max-age=300, stale-while-revalidate=3600",
    );
  } finally {
    globalThis.fetch = original;
  }
});
