import assert from "node:assert/strict";
import {
  issueWorkerToken,
  signWorkerRequest,
  WorkerAuthError,
  WorkerRequestAuthenticator,
} from "./workerAuth.ts";
import { MemoryWorkerRepository } from "./workerRepository.ts";

const now = Date.parse("2026-07-22T10:00:00.000Z");

Deno.test("authenticates a lease-bound signed request and rejects nonce replay", async () => {
  const repository = new MemoryWorkerRepository();
  const issued = await issueWorkerToken();
  await repository.replaceSession({
    tokenId: issued.tokenId,
    tokenHash: issued.tokenHash,
    workerId: "worker_test_001",
    serverId: "server_test_001",
    leaseId: "lease_test_001",
    expiresAt: "2026-07-22T10:05:00.000Z",
  });
  const request = {
    method: "POST",
    path: "/v1/internal/servers/server_test_001/worker/heartbeat",
    body: "{}",
    timestamp: String(now),
    nonce: "nonce_test_001",
  };
  const signature = await signWorkerRequest(issued.token, request);
  const authenticator = new WorkerRequestAuthenticator(repository, () => now);
  const signed = {
    ...request,
    authorization: `Worker ${issued.token}`,
    signature,
    serverId: "server_test_001",
    leaseId: "lease_test_001",
  };

  assert.equal(
    (await authenticator.authenticate(signed)).workerId,
    "worker_test_001",
  );
  await assert.rejects(
    () => authenticator.authenticate(signed),
    (error) =>
      error instanceof WorkerAuthError && error.code === "replay_detected",
  );
});

Deno.test("rejects stale timestamps, changed bodies, and cross-lease token use", async () => {
  const repository = new MemoryWorkerRepository();
  const issued = await issueWorkerToken();
  await repository.replaceSession({
    tokenId: issued.tokenId,
    tokenHash: issued.tokenHash,
    workerId: "worker_test_001",
    serverId: "server_test_001",
    leaseId: "lease_test_001",
    expiresAt: "2026-07-22T10:05:00.000Z",
  });
  const request = {
    method: "POST",
    path: "/worker/events",
    body: "{}",
    timestamp: String(now),
    nonce: "nonce_test_002",
  };
  const signature = await signWorkerRequest(issued.token, request);
  const authenticator = new WorkerRequestAuthenticator(repository, () => now);
  const base = {
    ...request,
    authorization: `Worker ${issued.token}`,
    signature,
    serverId: "server_test_001",
    leaseId: "lease_test_001",
  };

  await assert.rejects(
    () => authenticator.authenticate({ ...base, body: '{"changed":true}' }),
    (error) =>
      error instanceof WorkerAuthError && error.code === "invalid_signature",
  );
  await assert.rejects(
    () =>
      authenticator.authenticate({
        ...base,
        nonce: "nonce_stale",
        timestamp: String(now - 31_000),
      }),
    (error) =>
      error instanceof WorkerAuthError && error.code === "stale_request",
  );
  await assert.rejects(
    () =>
      authenticator.authenticate({
        ...base,
        nonce: "nonce_lease",
        leaseId: "lease_other",
      }),
    (error) =>
      error instanceof WorkerAuthError && error.code === "lease_conflict",
  );
});
