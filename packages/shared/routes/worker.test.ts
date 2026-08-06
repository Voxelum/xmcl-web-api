import assert from "node:assert/strict";
import {
  signWorkerRequest,
  WorkerRequestAuthenticator,
} from "../lib/workerAuth.ts";
import { MemoryWorkerRepository } from "../lib/workerRepository.ts";
import {
  type LeaseBinding,
  WorkerRuntimeService,
} from "../lib/worker/service.ts";
import { workerFixtures } from "../lib/worker/fixtures.ts";
import { createWorkerRoutes } from "./worker.ts";

const now = "2026-07-22T10:02:00.000Z";
const lease: LeaseBinding = {
  serverId: "server_test_001",
  leaseId: "lease_test_001",
  accountId: "account_test_001",
  authorizationId: "authorization_test_001",
  rateVersion: 3,
  status: "active",
};

async function createFixture(options: { failSettlementOnce?: boolean } = {}) {
  const repository = new MemoryWorkerRepository();
  const operations: string[] = [];
  let settlementAttempts = 0;
  const service = new WorkerRuntimeService({
    repository,
    leases: { getLease: () => Promise.resolve(lease) },
    bootstrap: {
      authenticate: ({ credential }) =>
        Promise.resolve(credential === "bootstrap-test"),
    },
    settlements: {
      settle(event) {
        settlementAttempts += 1;
        if (options.failSettlementOnce && settlementAttempts === 1) {
          return Promise.reject(new Error("m3_unavailable"));
        }
        return Promise.resolve({
          settlementId: "settlement_test_001",
          usageEventId: event.eventId,
          status: "settled",
          action: "continue",
        });
      },
    },
    events: { publish: () => Promise.resolve() },
    operations: {
      receive: ({ kind, operationId }) => {
        operations.push(`${kind}:${operationId}`);
        return Promise.resolve();
      },
    },
    now: () => now,
  });
  const app = createWorkerRoutes({
    service,
    authenticator: new WorkerRequestAuthenticator(
      repository,
      () => Date.parse(now),
    ),
    requestId: () => "request_test_001",
  });
  const registrationPath =
    `/v1/internal/servers/${lease.serverId}/worker/register`;
  const registrationBody = JSON.stringify({
    leaseId: lease.leaseId,
    workerId: "worker_test_001",
  });
  const registrationTimestamp = String(Date.parse(now));
  const registrationNonce = "registration_nonce_test";
  const registrationSignature = await signWorkerRequest("bootstrap-test", {
    method: "POST",
    path: registrationPath,
    body: registrationBody,
    timestamp: registrationTimestamp,
    nonce: registrationNonce,
  });
  const registration = await app.request(
    registrationPath,
    {
      method: "POST",
      headers: {
        authorization: "Worker-Bootstrap bootstrap-test",
        "content-type": "application/json",
        "x-worker-timestamp": registrationTimestamp,
        "x-worker-nonce": registrationNonce,
        "x-worker-signature": registrationSignature,
      },
      body: registrationBody,
    },
  );
  assert.equal(registration.status, 201);
  const token = (await registration.json() as { token: string }).token;
  let nonce = 0;

  async function signed(
    path: string,
    body: Record<string, unknown>,
    reuseNonce?: string,
  ) {
    const rawBody = JSON.stringify(body);
    const timestamp = String(Date.parse(now));
    const requestNonce = reuseNonce ?? `nonce_test_${++nonce}`;
    const signature = await signWorkerRequest(token, {
      method: "POST",
      path,
      body: rawBody,
      timestamp,
      nonce: requestNonce,
    });
    return await app.request(path, {
      method: "POST",
      headers: {
        authorization: `Worker ${token}`,
        "content-type": "application/json",
        "x-worker-timestamp": timestamp,
        "x-worker-nonce": requestNonce,
        "x-worker-signature": signature,
      },
      body: rawBody,
    });
  }

  return {
    app,
    signed,
    operations,
    settlementAttempts: () => settlementAttempts,
  };
}

Deno.test("worker route requires a signature, accepts a request, and rejects nonce replay", async () => {
  const fixture = await createFixture();
  const path = `/v1/internal/servers/${lease.serverId}/worker/heartbeat`;
  const unauthorized = await fixture.app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(workerFixtures.request.heartbeat),
  });
  assert.equal(unauthorized.status, workerFixtures.errors.unauthorized.status);
  assert.equal(
    (await unauthorized.json() as { action: string }).action,
    "registration_required",
  );

  const accepted = await fixture.signed(
    path,
    { ...workerFixtures.request.heartbeat },
    "nonce_replay_test",
  );
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), workerFixtures.response.accepted);

  const replay = await fixture.signed(
    path,
    { ...workerFixtures.request.heartbeat },
    "nonce_replay_test",
  );
  assert.equal(replay.status, workerFixtures.errors.replay.status);
  assert.equal(
    (await replay.json() as { error: string }).error,
    "replay_detected",
  );
});

Deno.test("worker usage returns provider failure and accepts a new signed retry", async () => {
  const fixture = await createFixture({ failSettlementOnce: true });
  const path = `/v1/internal/servers/${lease.serverId}/worker/usage`;
  const failure = await fixture.signed(path, {
    ...workerFixtures.request.usage,
  });
  assert.equal(failure.status, workerFixtures.errors.providerFailure.status);
  assert.equal(
    (await failure.json() as { error: string }).error,
    "worker_provider_unavailable",
  );

  const retry = await fixture.signed(path, { ...workerFixtures.request.usage });
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), {
    status: "accepted",
    action: "continue",
  });
  assert.equal(fixture.settlementAttempts(), 2);
});

Deno.test("documents and accepts logs, backup, and modpack operation endpoints", async () => {
  const fixture = await createFixture();
  const cases = [
    ["logs", "logs"],
    ["backup/export", "backup.export"],
    ["backup/restore", "backup.restore"],
    ["backup/events", "backup.event"],
    ["modpack/prepare", "modpack.prepare"],
    ["modpack/apply", "modpack.apply"],
    ["modpack/events", "modpack.event"],
  ] as const;
  for (const [pathSuffix, kind] of cases) {
    const operationId = `operation_${kind.replace(".", "_")}`;
    const path = `/v1/internal/servers/${lease.serverId}/worker/${pathSuffix}`;
    const response = await fixture.signed(path, {
      serverId: lease.serverId,
      leaseId: lease.leaseId,
      operationId,
      metadata: { objectKey: "opaque-test-key" },
    });
    assert.equal(response.status, 202, path);
    assert.deepEqual(await response.json(), {
      status: "accepted",
      operationId,
    });
  }
  assert.deepEqual(
    fixture.operations,
    cases.map(([, kind]) => `${kind}:operation_${kind.replace(".", "_")}`),
  );
});
