import assert from "node:assert/strict";
import { createAzureHttpApp } from "./httpApp.ts";

Deno.test("Azure exposes only the API mirror surface", () => {
  const paths = createAzureHttpApp({}).routes.map((route) => route.path);

  assert.equal(paths.includes("/translation"), true);
  assert.equal(paths.includes("/v1/account"), true);
  assert.equal(paths.includes("/v1/billing/balance"), true);
  assert.equal(paths.includes("/v1/chat/completions"), false);
  assert.equal(paths.includes("/v1/multiplayer/rooms"), false);
  assert.equal(paths.includes("/v1/rtc/official"), false);
});
