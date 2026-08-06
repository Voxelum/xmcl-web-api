import assert from "node:assert/strict";
import type { ExecutionContext } from "../src/cloudflare/types.ts";
import aiWorker from "./ai/worker.ts";
import apiWorker from "./api/worker.ts";
import signalingWorker from "./signaling/worker.ts";

const context: ExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
};

Deno.test("Cloudflare entrypoints own static, non-overlapping route surfaces", async () => {
  const [api, ai, signaling] = await Promise.all([
    routeIndex(apiWorker),
    routeIndex(aiWorker),
    routeIndex(signalingWorker),
  ]);

  assert.equal(api.includes("/translation"), true);
  assert.equal(api.includes("/v1/chat/completions"), false);
  assert.equal(api.includes("/v1/multiplayer/rooms"), false);

  assert.equal(ai.includes("/v1/chat/completions"), true);
  assert.equal(ai.includes("/translation"), false);
  assert.equal(ai.includes("/v1/multiplayer/rooms"), false);

  assert.equal(signaling.includes("/v1/multiplayer/rooms"), true);
  assert.equal(signaling.includes("/v1/rtc/official"), true);
  assert.equal(signaling.includes("/translation"), false);
  assert.equal(signaling.includes("/v1/chat/completions"), false);
});

interface WorkerEntrypoint {
  fetch(
    request: Request,
    env: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<Response>;
}

async function routeIndex(worker: WorkerEntrypoint) {
  const response = await worker.fetch(
    new Request("https://worker.test/"),
    {},
    context,
  );
  assert.equal(response.status, 200);
  return await response.json() as string[];
}
