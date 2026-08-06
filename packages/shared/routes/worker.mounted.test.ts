import assert from "node:assert/strict";
import { createApp } from "../app.ts";
import {
  signWorkerRequest,
  WorkerRequestAuthenticator,
} from "../lib/workerAuth.ts";
import { MemoryWorkerRepository } from "../lib/workerRepository.ts";
import {
  createWorkerRuntime,
  type WorkerRuntime,
} from "../lib/worker/runtime.ts";
import { type LeaseBinding } from "../lib/worker/service.ts";
import {
  DeterministicM3SettlementAdapter,
  DeterministicM4LeaseAdapter,
} from "../lib/worker/testing.ts";

const now = "2026-07-22T10:02:00.000Z";
const lease: LeaseBinding = {
  serverId: "server_mounted_001",
  leaseId: "lease_mounted_001",
  accountId: "account_mounted_001",
  authorizationId: "authorization_mounted_001",
  rateVersion: 1,
  status: "active",
};

function createRuntime(): {
  runtime: WorkerRuntime;
  settlements: DeterministicM3SettlementAdapter;
  events: Record<string, unknown>[];
} {
  const repository = new MemoryWorkerRepository();
  const settlements = new DeterministicM3SettlementAdapter({
    settlementId: "settlement_mounted_001",
    status: "rejected",
    action: "stop_required",
  });
  const events: Record<string, unknown>[] = [];
  return {
    runtime: createWorkerRuntime({
      repository,
      serverControlLeases: new DeterministicM4LeaseAdapter([lease]),
      billingSettlements: settlements,
      bootstrap: {
        authenticate: ({ credential }) =>
          Promise.resolve(credential === "bootstrap-mounted"),
      },
      events: {
        publish: (event) => {
          events.push(event);
          return Promise.resolve();
        },
      },
      operations: { receive: () => Promise.resolve() },
      now: () => now,
      authenticator: new WorkerRequestAuthenticator(
        repository,
        () => Date.parse(now),
      ),
      requestId: () => "request_mounted_001",
    }),
    settlements,
    events,
  };
}

function mountedApp(runtime: WorkerRuntime) {
  return createApp((app) => {
    app.use("*", async (context, next) => {
      context.set("workerRuntime", runtime);
      await next();
    });
  });
}

Deno.test("mounted worker routes report missing ServerControl/Billing adapter composition", async () => {
  const response = await createApp().request(
    `/v1/internal/servers/${lease.serverId}/worker/heartbeat`,
    { method: "POST", body: "{}" },
  );
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "m5_runtime_unavailable");
});

Deno.test("mounted worker routes authenticate, heartbeat, settle usage, and report stop", async () => {
  const fixture = createRuntime();
  const app = mountedApp(fixture.runtime);
  const registerPath = `/v1/internal/servers/${lease.serverId}/worker/register`;
  const registerBody = JSON.stringify({
    leaseId: lease.leaseId,
    workerId: "worker_mounted_001",
  });
  const timestamp = String(Date.parse(now));
  const register = await app.request(registerPath, {
    method: "POST",
    headers: {
      authorization: "Worker-Bootstrap bootstrap-mounted",
      "content-type": "application/json",
      "x-worker-timestamp": timestamp,
      "x-worker-nonce": "mounted-register",
      "x-worker-signature": await signWorkerRequest("bootstrap-mounted", {
        method: "POST",
        path: registerPath,
        body: registerBody,
        timestamp,
        nonce: "mounted-register",
      }),
    },
    body: registerBody,
  });
  assert.equal(register.status, 201);
  const token = (await register.json() as { token: string }).token;
  let nonce = 0;

  async function post(path: string, body: Record<string, unknown>) {
    const rawBody = JSON.stringify(body);
    const requestNonce = `mounted-${++nonce}`;
    return await app.request(path, {
      method: "POST",
      headers: {
        authorization: `Worker ${token}`,
        "content-type": "application/json",
        "x-worker-timestamp": timestamp,
        "x-worker-nonce": requestNonce,
        "x-worker-signature": await signWorkerRequest(token, {
          method: "POST",
          path,
          body: rawBody,
          timestamp,
          nonce: requestNonce,
        }),
      },
      body: rawBody,
    });
  }

  const heartbeatPath =
    `/v1/internal/servers/${lease.serverId}/worker/heartbeat`;
  const heartbeat = await post(heartbeatPath, {
    eventId: "heartbeat_mounted_001",
    serverId: lease.serverId,
    leaseId: lease.leaseId,
    status: "running",
    observedAt: "2026-07-22T10:00:30.000Z",
  });
  assert.equal(heartbeat.status, 200);

  const eventsPath = `/v1/internal/servers/${lease.serverId}/worker/events`;
  const healthy = await post(eventsPath, {
    eventId: "runtime_healthy_mounted_001",
    serverId: lease.serverId,
    leaseId: lease.leaseId,
    type: "healthy",
    occurredAt: "2026-07-22T10:00:30.000Z",
  });
  assert.equal(healthy.status, 202);

  const usagePath = `/v1/internal/servers/${lease.serverId}/worker/usage`;
  const usage = await post(usagePath, {
    eventId: "usage_mounted_001",
    serverId: lease.serverId,
    leaseId: lease.leaseId,
    sequence: 1,
    quantity: 60,
    intervalStart: "2026-07-22T10:00:00.000Z",
    intervalEnd: "2026-07-22T10:01:00.000Z",
    occurredAt: "2026-07-22T10:01:00.000Z",
    idempotencyKey: "m5:lease_mounted_001:1",
  });
  assert.equal(usage.status, 200);
  assert.deepEqual(await usage.json(), {
    status: "accepted",
    action: "stop_required",
  });
  assert.equal(fixture.settlements.received.length, 1);

  const stopped = await post(eventsPath, {
    eventId: "runtime_stopped_mounted_001",
    serverId: lease.serverId,
    leaseId: lease.leaseId,
    type: "stopped",
    occurredAt: "2026-07-22T10:02:00.000Z",
  });
  assert.equal(stopped.status, 202);
  assert.deepEqual(fixture.events.at(-1), {
    eventType: "runtime.stopped.v1",
    eventId: "runtime_stopped_mounted_001:balance-exhausted",
    schemaVersion: 1,
    serverId: lease.serverId,
    leaseId: lease.leaseId,
    settlementId: "settlement_mounted_001",
    reason: "balance_exhausted",
    occurredAt: "2026-07-22T10:02:00.000Z",
  });
});
