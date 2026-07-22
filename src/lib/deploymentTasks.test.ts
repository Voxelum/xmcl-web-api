// deno-lint-ignore-file require-await

import assert from "node:assert/strict";
import {
  InMemoryM9Repository,
  ModpackDeploymentCoordinator,
  ModpackDeploymentError,
  type ModpackDeploymentPrincipal,
  type WorkerDeploymentGateway,
} from "./deploymentTasks.ts";
import { validCompatibility } from "./modpackTestFixtures.ts";
import type { ValidatedModpack } from "./modpackValidator.ts";

const principal: ModpackDeploymentPrincipal = {
  accountId: "account_test",
  scopes: ["modpack:read", "modpack:write"],
};
const now = "2026-07-22T14:00:00.000Z";

function validated(): ValidatedModpack {
  return {
    report: {
      importId: "mpi_test",
      sourceFormat: "mrpack",
      status: "valid",
      configFiles: ["config/server.properties"],
      dataFiles: ["data/example/value.json"],
      mods: [{
        provider: "modrinth",
        projectId: "project-a",
        fileId: "version-a",
        filename: "example.jar",
        sha256: "a".repeat(64),
      }],
      rejectedFiles: [],
      compatibility: validCompatibility,
    },
    configFiles: [{
      path: "config/server.properties",
      sha256: "b".repeat(64),
      sizeBytes: 10,
      bytes: Uint8Array.of(1),
    }],
    dataFiles: [{
      path: "data/example/value.json",
      sha256: "c".repeat(64),
      sizeBytes: 12,
      bytes: Uint8Array.of(2),
    }],
    resolvedMods: [{
      provider: "modrinth",
      projectId: "project-a",
      fileId: "version-a",
      filename: "example.jar",
      sha256: "a".repeat(64),
      sizeBytes: 100,
      downloadUrl: "https://cdn.modrinth.com/data/a/b/example.jar",
    }],
  };
}

function fixture(options: {
  compatibility?: typeof validCompatibility;
  stageFailures?: number;
  stageHash?: string;
  state?: "running" | "stopped";
  runtimeStopped?: {
    eventType: "runtime.stopped.v1";
    eventId: string;
    schemaVersion: 1;
    serverId: string;
    leaseId: string;
    settlementId: string;
    reason: "balance_exhausted";
    occurredAt: string;
  };
} = {}) {
  const repository = new InMemoryM9Repository();
  const queued: string[] = [];
  const calls: string[] = [];
  let failures = options.stageFailures ?? 0;
  let activeDeploymentId = "mpd_previous";
  const worker: WorkerDeploymentGateway = {
    async createRollbackSnapshot() {
      calls.push("snapshot");
      return "snapshot_previous";
    },
    async stageAndVerify(input) {
      calls.push("stage");
      if (failures-- > 0) throw new Error("staging_unavailable");
      return {
        stagingId: "staging_verified",
        manifestSha256: options.stageHash ??
          await repository.getDeployment(input.manifest.deploymentId)
            .then((record) => record!.manifestSha256!),
      };
    },
    async atomicSwitch(input) {
      calls.push("switch");
      activeDeploymentId = input.deploymentId;
    },
    async restoreSnapshot(input) {
      calls.push(`restore:${input.snapshotId}`);
      activeDeploymentId = "mpd_previous";
    },
  };
  let sequence = 0;
  const coordinator = new ModpackDeploymentCoordinator(
    repository,
    {
      createUpload: async () => ({
        uploadUrl: "https://storage.invalid/signed",
        expiresAt: now,
        maxSizeBytes: 1024,
      }),
      readVerified: async () => {
        throw new Error("unused");
      },
    },
    {
      getDeploymentTarget: async (accountId, serverId) => ({
        accountId,
        serverId,
        state: options.state ?? "running",
        compatibility: options.compatibility ?? validCompatibility,
        activeDeploymentId,
        runtimeStopped: options.runtimeStopped,
      }),
    },
    worker,
    {
      async enqueue(taskId) {
        queued.push(taskId);
      },
    },
    [],
    () => now,
    (prefix) => `${prefix}_test_${++sequence}`,
  );

  async function seed() {
    await repository.putImport({
      importId: "mpi_test",
      serverId: "server_test",
      accountId: principal.accountId,
      sourceFormat: "mrpack",
      status: "valid",
      expectedSha256: "d".repeat(64),
      expectedSizeBytes: 100,
      validation: validated().report,
      createdAt: now,
      updatedAt: now,
    });
    await repository.putValidated("mpi_test", validated());
  }

  async function prepare() {
    await seed();
    const created = await coordinator.createDeployment({
      principal,
      requestId: "request_create",
      idempotencyKey: "create-key",
      serverId: "server_test",
      importId: "mpi_test",
    });
    await coordinator.runTask(created.task.taskId);
    return created.deployment.deploymentId;
  }

  async function preview(deploymentId: string) {
    const queuedPreview = await coordinator.preview({
      principal,
      requestId: "request_preview",
      idempotencyKey: "preview-key",
      deploymentId,
    });
    return await coordinator.runTask(queuedPreview.task.taskId);
  }

  return {
    repository,
    coordinator,
    queued,
    calls,
    prepare,
    preview,
    active: () => activeDeploymentId,
    seed,
  };
}

Deno.test("freezes the complete manifest after async preview with rollback snapshot", async () => {
  const test = fixture();
  const deploymentId = await test.prepare();
  const task = await test.preview(deploymentId);
  const deployment = await test.repository.getDeployment(deploymentId);

  assert.equal(task.status, "succeeded");
  assert.equal(deployment?.status, "previewed");
  assert.equal(deployment?.manifest?.rollbackSnapshotId, "snapshot_previous");
  assert.equal(deployment?.manifest?.compatibility.javaMajor, 21);
  assert.equal(deployment?.manifest?.configFiles[0].sha256, "b".repeat(64));
  assert.equal(deployment?.manifest?.mods[0].sha256, "a".repeat(64));
  assert.equal(deployment?.manifestSha256?.length, 64);
  assert.equal(Object.isFrozen(deployment?.manifest), true);
  assert.equal(Object.isFrozen(deployment?.manifest?.mods), true);
  assert.deepEqual(test.calls, ["snapshot"]);
});

Deno.test("stages and verifies before atomically switching, then restores snapshot", async () => {
  const test = fixture();
  const deploymentId = await test.prepare();
  await test.preview(deploymentId);
  const deployment = await test.repository.getDeployment(deploymentId);
  const queuedApply = await test.coordinator.apply({
    principal,
    requestId: "request_apply",
    idempotencyKey: "apply-key",
    deploymentId,
    manifestSha256: deployment!.manifestSha256!,
  });
  const applied = await test.coordinator.runTask(queuedApply.task.taskId);

  assert.equal(applied.status, "succeeded");
  assert.equal(test.active(), deploymentId);
  assert.deepEqual(test.calls, ["snapshot", "stage", "switch"]);

  const queuedRollback = await test.coordinator.rollback({
    principal,
    requestId: "request_rollback",
    idempotencyKey: "rollback-key",
    deploymentId,
  });
  const rolledBack = await test.coordinator.runTask(queuedRollback.task.taskId);
  assert.equal(rolledBack.status, "succeeded");
  assert.equal(test.active(), "mpd_previous");
  assert.equal(
    (await test.repository.getDeployment(deploymentId))?.status,
    "rolled_back",
  );
  assert.equal(test.calls.at(-1), "restore:snapshot_previous");
});

Deno.test("staging failure preserves the active deployment and the failed task can retry", async () => {
  const test = fixture({ stageFailures: 1 });
  const deploymentId = await test.prepare();
  await test.preview(deploymentId);
  const manifestSha256 = (await test.repository.getDeployment(deploymentId))!
    .manifestSha256!;
  const queuedApply = await test.coordinator.apply({
    principal,
    requestId: "request_apply",
    idempotencyKey: "apply-key",
    deploymentId,
    manifestSha256,
  });

  const failed = await test.coordinator.runTask(queuedApply.task.taskId);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error?.error, "worker_staging_failed");
  assert.equal(test.active(), "mpd_previous");
  assert.equal(
    (await test.repository.getDeployment(deploymentId))?.status,
    "apply_failed",
  );

  const retried = await test.coordinator.runTask(queuedApply.task.taskId);
  assert.equal(retried.status, "succeeded");
  assert.equal(retried.error, undefined);
  assert.equal(test.active(), deploymentId);
});

Deno.test("rejects a worker staging hash mismatch without switching", async () => {
  const test = fixture({ stageHash: "f".repeat(64) });
  const deploymentId = await test.prepare();
  await test.preview(deploymentId);
  const manifestSha256 = (await test.repository.getDeployment(deploymentId))!
    .manifestSha256!;
  const queuedApply = await test.coordinator.apply({
    principal,
    requestId: "request_apply_hash",
    idempotencyKey: "apply-hash-key",
    deploymentId,
    manifestSha256,
  });
  const failed = await test.coordinator.runTask(queuedApply.task.taskId);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error?.error, "worker_hash_mismatch");
  assert.equal(test.active(), "mpd_previous");
  assert.equal(test.calls.includes("switch"), false);
});

Deno.test("does not stage a deployment after the shared v1 balance-exhaustion stop", async () => {
  const test = fixture({
    state: "stopped",
    runtimeStopped: {
      eventType: "runtime.stopped.v1",
      eventId: "runtime_123",
      schemaVersion: 1,
      serverId: "server_test",
      leaseId: "lease_123",
      settlementId: "settlement_123",
      reason: "balance_exhausted",
      occurredAt: "2026-07-23T00:00:05Z",
    },
  });
  const deploymentId = await test.prepare();
  await test.preview(deploymentId);
  const manifestSha256 = (await test.repository.getDeployment(deploymentId))!
    .manifestSha256!;
  await assert.rejects(
    () =>
      test.coordinator.apply({
        principal,
        requestId: "request_apply_after_stop",
        idempotencyKey: "apply-after-stop-key",
        deploymentId,
        manifestSha256,
      }),
    (error: unknown) =>
      error instanceof ModpackDeploymentError &&
      error.code === "server_not_ready",
  );
  assert.equal(test.active(), "mpd_previous");
  assert.equal(test.calls.includes("stage"), false);
});

Deno.test("returns one task for duplicate commands and rejects idempotency conflicts", async () => {
  const test = fixture();
  const create = {
    principal,
    requestId: "request_import",
    idempotencyKey: "import-key",
    serverId: "server_test",
    sourceFormat: "mrpack" as const,
    expectedSha256: "e".repeat(64),
    expectedSizeBytes: 100,
  };
  const first = await test.coordinator.createImport(create);
  const retry = await test.coordinator.createImport(create);
  assert.equal(retry.importId, first.importId);
  await assert.rejects(
    () => test.coordinator.createImport({ ...create, expectedSizeBytes: 101 }),
    (error) =>
      error instanceof ModpackDeploymentError &&
      error.code === "idempotency_conflict",
  );
});

Deno.test("rejects incompatible ServerControl template matrix before preview", async () => {
  const test = fixture({
    compatibility: { ...validCompatibility, javaMajor: 17 },
  });

  await test.seed();
  const created = await test.coordinator.createDeployment({
    principal,
    requestId: "request_create",
    idempotencyKey: "create-key",
    serverId: "server_test",
    importId: "mpi_test",
  });
  const failed = await test.coordinator.runTask(created.task.taskId);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error?.error, "incompatible_template");
  assert.equal(
    (await test.repository.getDeployment(created.deployment.deploymentId))
      ?.status,
    "preparing",
  );
});

Deno.test("rejects rollback when the immutable snapshot is missing", async () => {
  const test = fixture();
  await test.repository.putDeployment({
    deploymentId: "mpd_missing_snapshot",
    importId: "mpi_test",
    serverId: "server_test",
    accountId: principal.accountId,
    status: "applied",
    createdAt: now,
    updatedAt: now,
  });
  await assert.rejects(
    () =>
      test.coordinator.rollback({
        principal,
        requestId: "request_rollback_missing",
        idempotencyKey: "rollback-missing-key",
        deploymentId: "mpd_missing_snapshot",
      }),
    (error) =>
      error instanceof ModpackDeploymentError &&
      error.code === "rollback_snapshot_missing",
  );
});

Deno.test("deduplicates worker events and rejects out-of-order, conflicting and invalid-state delivery", async () => {
  const test = fixture();
  const deploymentId = await test.prepare();
  await test.preview(deploymentId);
  const deployment = await test.repository.getDeployment(deploymentId);
  const queuedApply = await test.coordinator.apply({
    principal,
    requestId: "request_apply",
    idempotencyKey: "apply-key",
    deploymentId,
    manifestSha256: deployment!.manifestSha256!,
  });
  await test.coordinator.runTask(queuedApply.task.taskId);
  const event = {
    deploymentId,
    eventId: "worker_switch_2",
    sequence: 2,
    type: "switch_completed" as const,
    manifestSha256: deployment!.manifestSha256,
  };
  assert.deepEqual(await test.coordinator.acceptWorkerEvent(event), {
    duplicate: false,
  });
  assert.deepEqual(await test.coordinator.acceptWorkerEvent(event), {
    duplicate: true,
  });
  await assert.rejects(
    () =>
      test.coordinator.acceptWorkerEvent({
        ...event,
        eventId: "worker_switch_1",
        sequence: 1,
      }),
    (error) =>
      error instanceof ModpackDeploymentError && error.code === "out_of_order",
  );
  await assert.rejects(
    () =>
      test.coordinator.acceptWorkerEvent({
        ...event,
        manifestSha256: "f".repeat(64),
      }),
    (error) =>
      error instanceof ModpackDeploymentError &&
      error.code === "worker_hash_mismatch",
  );
  await assert.rejects(
    () =>
      test.coordinator.acceptWorkerEvent({
        ...event,
        eventId: "worker_stage_late",
        sequence: 3,
        type: "stage_verified",
      }),
    (error) =>
      error instanceof ModpackDeploymentError &&
      error.code === "state_conflict",
  );
});
