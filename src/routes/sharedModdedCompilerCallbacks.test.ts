import assert from "node:assert/strict";
import { Hono } from "hono";
import {
  HmacCompilerServiceIdentity,
  type CompilerNonceStore,
} from "../lib/compilerServiceIdentity.ts";
import type { SharedModdedRuntimeService } from "../lib/sharedModdedRuntime.ts";
import type { AppEnv } from "../types.ts";
import { createSharedModdedCompilerRoutes } from "./sharedModdedRuntime.ts";

const secret = "compiler-callback-secret-at-least-thirty-two-bytes";
const now = 1_785_000_000_000;

class Nonces implements CompilerNonceStore {
  readonly durable = true as const;
  private readonly used = new Set<string>();
  async consume(input: { key: string }) {
    if (this.used.has(input.key)) return false;
    this.used.add(input.key);
    return true;
  }
}

function identity(store = new Nonces()) {
  return new HmacCompilerServiceIdentity({
    keyId: "compiler-v1",
    secret,
    nonceStore: store,
    now: () => now,
  });
}

function callbacks(calls: unknown[]) {
  const runtime = {
    publishCompilerResult: async (input: unknown) => {
      calls.push(input);
      return { status: "published" };
    },
  } as unknown as SharedModdedRuntimeService;
  const app = new Hono<AppEnv>();
  const verifier = identity();
  app.use("*", async (c, next) => {
    const raw = new Uint8Array(await c.req.raw.arrayBuffer());
    try {
      await verifier.verifyIncoming({
        method: c.req.method,
        target: new URL(c.req.url).pathname,
        headers: c.req.raw.headers,
        body: raw,
      });
    } catch {
      return c.json({ error: "unauthorized" }, 401);
    }
    c.set("sharedModdedCompilerPrincipal", { compilerId: "compiler-v1" });
    c.set("sharedModdedCompilerRawBody", raw);
    await next();
  });
  app.route("/", createSharedModdedCompilerRoutes(runtime));
  return app;
}

async function signedRequest(body: Uint8Array) {
  const target =
    "/v1/internal/shared-runtime-compiler/deployments/deployment_1/published";
  const headers = await identity().signOutgoing({ method: "POST", target, body });
  return new Request(`https://control.example${target}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body as unknown as BodyInit,
  });
}

Deno.test("compiler callback route authenticates exact raw bytes before changing deployment state", async () => {
  const calls: unknown[] = [];
  const app = callbacks(calls);
  const body = new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    status: "published",
    compilerRequestId: "compile_request_1",
    deploymentId: "deployment_1",
    manifestSha256: "a".repeat(64),
    content: { key: "content", sha256: "b".repeat(64) },
    descriptor: {},
  }));
  const request = await signedRequest(body);
  const accepted = await app.request(request);
  assert.equal(accepted.status, 200);
  assert.equal(calls.length, 1);

  const replay = await app.request(new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: body as unknown as BodyInit,
  }));
  assert.equal(replay.status, 401);
  assert.equal(calls.length, 1);

  const original = await signedRequest(body);
  const substituted = new Request(original.url, {
    method: "POST",
    headers: original.headers,
    body: new TextEncoder().encode(new TextDecoder().decode(body).replace(
      "compile_request_1",
      "compile_request_2",
    )) as unknown as BodyInit,
  });
  const rejected = await app.request(substituted);
  assert.equal(rejected.status, 401);
  assert.equal(calls.length, 1);
});
