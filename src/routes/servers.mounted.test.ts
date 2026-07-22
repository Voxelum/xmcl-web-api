import assert from "node:assert/strict";
import { createApp } from "../app.ts";
import {
  createServerControlRuntime,
  type ServerControlRuntime,
} from "../lib/serverControlRuntime.ts";
import type { AccountRuntime } from "../lib/accountRuntime.ts";
import { MemoryServerRepository } from "../lib/serverRepository.ts";
import type { VultrAdapter } from "../lib/vultr.ts";

const accountId = "account_m4_mounted";

const provider: VultrAdapter = {
  validateCapacity: () => Promise.resolve(),
  createInstance: () => Promise.reject(new Error("not used by route test")),
  reconcileCreate: () => Promise.resolve(undefined),
  getInstance: () => Promise.resolve(undefined),
  start: () => Promise.resolve(),
  halt: () => Promise.resolve(),
  reboot: () => Promise.resolve(),
  delete: () => Promise.resolve(),
};

function runtime(): ServerControlRuntime {
  return createServerControlRuntime({
    repository: new MemoryServerRepository(),
    vultr: provider,
    billingAuthorizations: {
      authorize: (request) =>
        Promise.resolve({
          authorizationId: "authorization_mounted",
          accountId: request.accountId,
          resource: "server_time",
          sourceId: request.sourceId,
          status: "authorized",
          rateVersion: request.rateVersion,
          expiresAt: request.expiresAt,
          actionOnExhaustion: "stop_required",
        }),
      release: () => Promise.resolve(),
    },
    workerStops: { requestGracefulStop: () => Promise.resolve("accepted") },
    worldBackupDeletion: {
      confirmServerDeletion: () => Promise.resolve("confirmed"),
    },
    expiredStops: { listExpiredStops: () => Promise.resolve([]) },
    adminOperationService: { complete: () => Promise.resolve() },
    id: ((prefix: string) => `${prefix}_mounted`) as never,
  });
}

const accountRuntime = {
  sessions: {
    verify(token: string) {
      if (token !== "mounted-session") {
        return Promise.reject(new Error("bad token"));
      }
      return Promise.resolve({
        accountId,
        scopes: ["account:read", "account:write"],
      });
    },
  },
} as unknown as AccountRuntime;

function mountedApp(serverControlRuntime: ServerControlRuntime) {
  return createApp((app) => {
    app.use("*", async (context, next) => {
      context.set("accountRuntime", accountRuntime);
      context.set("serverControlRuntime", serverControlRuntime);
      await next();
    });
  });
}

Deno.test("mounted ServerControl routes fail explicitly without injected runtime", async () => {
  const response = await createApp().request("/v1/servers");
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "m4_runtime_unavailable");
});

Deno.test("mounted ServerControl routes authenticate through Account and use the injected ServerControl runtime", async () => {
  const app = mountedApp(runtime());
  const headers = {
    authorization: "Bearer mounted-session",
    "content-type": "application/json",
    "idempotency-key": "mounted-create",
    "x-request-id": "mounted-request",
  };
  const created = await app.request("/v1/servers", {
    method: "POST",
    headers,
    body: JSON.stringify({ plan: "vc2-2c-4gb" }),
  });
  assert.equal(created.status, 202);
  const task = await created.json();
  assert.equal(task.status, "queued");

  const listed = await app.request("/v1/servers", {
    headers: { authorization: "Bearer mounted-session" },
  });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).length, 1);

  const rejected = await app.request("/v1/servers", {
    headers: { authorization: "Bearer invalid-session" },
  });
  assert.equal(rejected.status, 401);
});
