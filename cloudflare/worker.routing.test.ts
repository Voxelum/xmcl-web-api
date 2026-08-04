import assert from "node:assert/strict";
import { routeSurfaceForHost } from "./worker.ts";

Deno.test("Cloudflare custom domains select isolated route surfaces", () => {
  assert.equal(routeSurfaceForHost("api.xmcl.app"), "common");
  assert.equal(routeSurfaceForHost("ai.xmcl.app"), "ai");
  assert.equal(routeSurfaceForHost("signaling.xmcl.app"), "signaling");
  assert.equal(routeSurfaceForHost("preview.workers.dev"), "common");
  assert.equal(routeSurfaceForHost("preview.workers.dev", "ai"), "ai");
});
