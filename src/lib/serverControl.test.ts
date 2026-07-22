import assert from "node:assert/strict";
import {
  adminSuspend,
  balanceStopRequired,
  conflictingWorkerHealthy,
  duplicateWorkerHealthy,
  outOfOrderWorkerHealthy,
  retriedWorkerHealthy,
  runtimeStopped,
  workerHealthy,
} from "./serverControlFixtures.ts";
import type {
  BillingAuthorizationGateway,
  WorkerGateway,
} from "./serverControlProposals.ts";
import { ServerControlError, ServerControlService } from "./serverControl.ts";
import { MemoryServerRepository } from "./serverRepository.ts";
import type {
  CreateVultrInstance,
  VultrAdapter,
  VultrInstance,
} from "./vultr.ts";
import { VultrError } from "./vultr.ts";

class FixtureVultr implements VultrAdapter {
  readonly calls: string[] = [];
  failCreateUnknown = false;
  instance: VultrInstance | undefined;

  validateCapacity(plan: string) {
    this.calls.push(`validate:${plan}`);
    return Promise.resolve();
  }

  createInstance(input: CreateVultrInstance) {
    this.calls.push(`create:${input.serverId}`);
    if (this.failCreateUnknown) {
      return Promise.reject(new VultrError("provider_unknown", "unknown"));
    }
    this.instance = {
      id: "provider-secret-id",
      region: "tpe",
      plan: input.plan,
      label: input.serverId,
      status: "active",
      powerStatus: "running",
      serverStatus: "ok",
      address: "203.0.113.8",
    };
    return Promise.resolve(structuredClone(this.instance));
  }

  reconcileCreate() {
    return Promise.resolve(
      this.instance ? structuredClone(this.instance) : undefined,
    );
  }

  getInstance() {
    return Promise.resolve(
      this.instance ? structuredClone(this.instance) : undefined,
    );
  }

  start() {
    this.calls.push("start");
    if (this.instance) this.instance.powerStatus = "running";
    return Promise.resolve();
  }

  halt() {
    this.calls.push("halt");
    if (this.instance) this.instance.powerStatus = "stopped";
    return Promise.resolve();
  }

  reboot() {
    this.calls.push("reboot");
    if (this.instance) this.instance.powerStatus = "running";
    return Promise.resolve();
  }

  delete() {
    this.calls.push("delete");
    this.instance = undefined;
    return Promise.resolve();
  }
}

function fixture(options: {
  authorization?: BillingAuthorizationGateway;
  worker?: WorkerGateway;
  vultr?: FixtureVultr;
} = {}) {
  let idSequence = 0;
  let now = "2026-07-22T14:00:00.000Z";
  const released: string[] = [];
  const authorizationCalls: string[] = [];
  const gracefulStops: string[] = [];
  const vultr = options.vultr ?? new FixtureVultr();
  const authorizations = options.authorization ?? {
    authorize(request) {
      authorizationCalls.push(request.idempotencyKey);
      return Promise.resolve({
        accountId: request.accountId,
        resource: request.resource,
        sourceId: request.sourceId,
        status: "authorized" as const,
        authorizationId: `authorization-${authorizationCalls.length}`,
        rateVersion: request.rateVersion,
        expiresAt: request.expiresAt,
        actionOnExhaustion: "stop_required" as const,
      });
    },
    release(authorizationId) {
      released.push(authorizationId);
      return Promise.resolve();
    },
  };
  const worker = options.worker ?? {
    requestGracefulStop(input) {
      gracefulStops.push(input.deadline);
      return Promise.resolve("unreachable" as const);
    },
  };
  const service = new ServerControlService({
    repository: new MemoryServerRepository(),
    provider: vultr,
    authorizations,
    worker,
    deletion: {
      confirmServerDeletion: () => Promise.resolve("confirmed" as const),
    },
    now: () => now,
    id(prefix) {
      idSequence += 1;
      if (prefix === "server" && idSequence === 1) {
        return "server_m4_fixture";
      }
      return `${prefix}_fixture_${idSequence}`;
    },
    forcedStopTimeoutMs: 300_000,
  });
  return {
    service,
    vultr,
    released,
    authorizationCalls,
    gracefulStops,
    setNow(value: string) {
      now = value;
    },
  };
}

const accountId = "acct_m4_fixture";

Deno.test("owns lifecycle state, activates a lease only after worker health, and force-stops an unresponsive worker", async () => {
  const setup = fixture();
  const created = await setup.service.create(accountId, {
    plan: "vc2-2c-4gb",
  }, {
    idempotencyKey: "create-1",
    requestId: "request-create-1",
  });
  assert.equal(
    (await setup.service.get(accountId, created.resource.id)).status,
    "creating",
  );

  const provisioned = await setup.service.executeTask(
    accountId,
    created.taskId,
  );
  assert.equal(provisioned.status, "succeeded");
  let server = await setup.service.get(accountId, created.resource.id);
  assert.equal(server.status, "stopped");
  assert.equal(server.statusVersion, 2);

  const started = await setup.service.start(accountId, server.serverId, {
    idempotencyKey: "start-1",
    requestId: "request-start-1",
  });
  await setup.service.executeTask(accountId, started.taskId);
  server = await setup.service.get(accountId, server.serverId);
  assert.equal(server.status, "starting");
  assert.equal(
    (await setup.service.getTask(accountId, started.taskId)).status,
    "running",
  );

  assert.equal(await setup.service.handleWorkerEvent(workerHealthy), "applied");
  server = await setup.service.get(accountId, server.serverId);
  assert.equal(server.status, "running");
  assert.equal(server.statusVersion, 4);
  assert.equal(server.address, "203.0.113.8");
  const stateAfterHealth = await setup.service.getTask(
    accountId,
    started.taskId,
  );
  assert.equal(stateAfterHealth.status, "succeeded");

  const stopped = await setup.service.stop(accountId, server.serverId, {
    idempotencyKey: "stop-1",
    requestId: "request-stop-1",
  });
  await assert.rejects(
    () =>
      setup.service.forceStopAfterTimeout(
        accountId,
        stopped.taskId,
        "2026-07-22T14:01:00.000Z",
      ),
    (error) => error instanceof ServerControlError && error.code === "conflict",
  );
  await setup.service.forceStopAfterTimeout(
    accountId,
    stopped.taskId,
    "2026-07-22T14:05:00.000Z",
  );
  server = await setup.service.get(accountId, server.serverId);
  assert.equal(server.status, "stopped");
  assert.equal(server.statusReason, "worker_unresponsive");
  assert.equal(server.address, undefined);
  assert.equal(
    (await setup.service.getTask(accountId, stopped.taskId)).status,
    "succeeded",
  );
  assert.equal(setup.released.length, 2);
  assert.ok(setup.vultr.calls.includes("halt"));
});

Deno.test("Idempotency-Key replays one task and rejects a conflicting payload", async () => {
  const setup = fixture();
  const first = await setup.service.create(accountId, {
    plan: "vc2-2c-4gb",
  }, {
    idempotencyKey: "same-key",
    requestId: "request-1",
  });
  const retry = await setup.service.create(accountId, {
    plan: "vc2-2c-4gb",
  }, {
    idempotencyKey: "same-key",
    requestId: "request-2",
  });
  assert.equal(retry.taskId, first.taskId);
  assert.equal(setup.authorizationCalls.length, 1);
  await assert.rejects(
    () =>
      setup.service.create(accountId, { plan: "vc2-4c-8gb" }, {
        idempotencyKey: "same-key",
        requestId: "request-3",
      }),
    (error) =>
      error instanceof ServerControlError &&
      error.code === "idempotency_conflict",
  );
});

Deno.test("concurrent idempotent create claims one server and one task", async () => {
  let releaseAuthorization!: () => void;
  const pending = new Promise<void>((resolve) => {
    releaseAuthorization = resolve;
  });
  const setup = fixture({
    authorization: {
      async authorize(request) {
        await pending;
        return {
          accountId: request.accountId,
          resource: request.resource,
          sourceId: request.sourceId,
          status: "authorized",
          authorizationId: "authorization-concurrent",
          rateVersion: request.rateVersion,
          expiresAt: request.expiresAt,
          actionOnExhaustion: "stop_required",
        };
      },
      release: () => Promise.resolve(),
    },
  });
  const first = setup.service.create(accountId, { plan: "vc2-2c-4gb" }, {
    idempotencyKey: "concurrent-key",
    requestId: "request-concurrent-1",
  });
  const second = setup.service.create(accountId, { plan: "vc2-2c-4gb" }, {
    idempotencyKey: "concurrent-key",
    requestId: "request-concurrent-2",
  });
  releaseAuthorization();
  const [firstTask, secondTask] = await Promise.all([first, second]);
  assert.equal(firstTask.taskId, secondTask.taskId);
  assert.equal((await setup.service.list(accountId)).length, 1);
});

Deno.test("provider unknown outcome remains reconcilable and does not blindly create twice", async () => {
  const vultr = new FixtureVultr();
  vultr.failCreateUnknown = true;
  const setup = fixture({ vultr });
  const task = await setup.service.create(accountId, {
    plan: "vc2-2c-4gb",
  }, {
    idempotencyKey: "provider-unknown",
    requestId: "request-provider",
  });
  const result = await setup.service.executeTask(accountId, task.taskId);
  assert.equal(result.status, "running");
  assert.equal(result.error?.error, "provider_unknown");
  assert.equal(
    (await setup.service.get(accountId, task.resource.id)).statusReason,
    "provider_reconciliation_required",
  );
  await setup.service.executeTask(accountId, task.taskId);
  assert.equal(
    vultr.calls.filter((call) => call.startsWith("create:")).length,
    1,
  );
});

Deno.test("event fixtures deduplicate, reject conflicting IDs, and ignore stale ordering", async () => {
  const setup = fixture();
  const create = await setup.service.create(accountId, {
    plan: "vc2-2c-4gb",
  }, {
    idempotencyKey: "events-create",
    requestId: "events-create",
  });
  await setup.service.executeTask(accountId, create.taskId);
  const start = await setup.service.start(accountId, create.resource.id, {
    idempotencyKey: "events-start",
    requestId: "events-start",
  });
  await setup.service.executeTask(accountId, start.taskId);

  assert.equal(await setup.service.handleWorkerEvent(workerHealthy), "applied");
  assert.equal(
    await setup.service.handleWorkerEvent(duplicateWorkerHealthy),
    "duplicate",
  );
  assert.equal(
    await setup.service.handleWorkerEvent(outOfOrderWorkerHealthy),
    "out_of_order",
  );
  assert.equal(
    await setup.service.handleWorkerEvent(retriedWorkerHealthy),
    "ignored",
  );
  await assert.rejects(
    () => setup.service.handleWorkerEvent(conflictingWorkerHealthy),
    (error) => error instanceof ServerControlError && error.code === "conflict",
  );
});

Deno.test("D5 starts a 300-second escalation, then closes the lease only for runtime.stopped.v1", async () => {
  const setup = fixture();
  const create = await setup.service.create(accountId, {
    plan: "vc2-2c-4gb",
  }, {
    idempotencyKey: "control-create",
    requestId: "control-create",
  });
  await setup.service.executeTask(accountId, create.taskId);
  const start = await setup.service.start(accountId, create.resource.id, {
    idempotencyKey: "control-start",
    requestId: "control-start",
  });
  await setup.service.executeTask(accountId, start.taskId);
  await setup.service.handleWorkerEvent(workerHealthy);

  const running = await setup.service.get(accountId, create.resource.id);
  const releasedBeforeBalanceStop = setup.released.length;
  assert.equal(
    await setup.service.recordBalanceStopRequired(accountId, {
      ...balanceStopRequired,
      serverId: create.resource.id,
      leaseId: running.leaseId!,
    }),
    "applied",
  );
  assert.equal(
    await setup.service.recordBalanceStopRequired(accountId, {
      ...balanceStopRequired,
      serverId: create.resource.id,
      leaseId: running.leaseId!,
    }),
    "duplicate",
  );
  const server = await setup.service.get(accountId, create.resource.id);
  assert.equal(server.status, "billing_blocked");
  assert.equal(server.desiredStatus, "stopped");
  assert.equal(setup.released.length, releasedBeforeBalanceStop);
  assert.equal(
    await setup.service.handleWorkerEvent({
      ...workerHealthy,
      eventId: "evt_worker_healthy_after_billing",
      sequence: 10,
    }),
    "ignored",
  );
  assert.equal(
    await setup.service.handleRuntimeStopped(accountId, {
      ...runtimeStopped,
      serverId: create.resource.id,
      leaseId: running.leaseId!,
    }),
    "applied",
  );
  assert.equal(
    await setup.service.handleRuntimeStopped(accountId, {
      ...runtimeStopped,
      serverId: create.resource.id,
      leaseId: running.leaseId!,
    }),
    "duplicate",
  );
  assert.equal(
    (await setup.service.get(accountId, create.resource.id)).status,
    "stopped",
  );
  assert.equal(setup.released.length, releasedBeforeBalanceStop + 1);
});

Deno.test("Billing rejection prevents resource creation", async () => {
  const setup = fixture({
    authorization: {
      authorize: () =>
        Promise.resolve({
          status: "rejected" as const,
          reason: "insufficient_balance" as const,
        }),
      release: () => Promise.resolve(),
    },
  });

  await assert.rejects(
    () =>
      setup.service.create(accountId, { plan: "vc2-2c-4gb" }, {
        idempotencyKey: "denied",
        requestId: "denied",
      }),
    (error) =>
      error instanceof ServerControlError &&
      error.code === "insufficient_balance",
  );
  assert.deepEqual(await setup.service.list(accountId), []);
});

Deno.test("D5 force-stops after 300 seconds when runtime.stopped.v1 is absent", async () => {
  const setup = fixture();
  const create = await setup.service.create(
    accountId,
    { plan: "vc2-2c-4gb" },
    { idempotencyKey: "d5-timeout-create", requestId: "d5-timeout-create" },
  );
  await setup.service.executeTask(accountId, create.taskId);
  const start = await setup.service.start(accountId, create.resource.id, {
    idempotencyKey: "d5-timeout-start",
    requestId: "d5-timeout-start",
  });
  await setup.service.executeTask(accountId, start.taskId);
  await setup.service.handleWorkerEvent(workerHealthy);
  const running = await setup.service.get(accountId, create.resource.id);
  await setup.service.recordBalanceStopRequired(accountId, {
    ...balanceStopRequired,
    serverId: create.resource.id,
    leaseId: running.leaseId!,
    settlementId: "settlement_m4_timeout",
  });
  const stopTask = await setup.service.get(
    accountId,
    create.resource.id,
  );
  await assert.rejects(
    () =>
      setup.service.forceStopAfterTimeout(
        accountId,
        stopTask.taskId,
        "2026-07-22T14:09:59.000Z",
      ),
    (error) => error instanceof ServerControlError && error.code === "conflict",
  );
  assert.deepEqual(
    await setup.service.sweepExpiredStops([{
      accountId,
      taskId: stopTask.taskId,
    }], "2026-07-22T14:10:00.000Z"),
    [{ accountId, taskId: stopTask.taskId, status: "forced" }],
  );
  const stopped = await setup.service.get(accountId, create.resource.id);
  assert.equal(stopped.status, "billing_blocked");
  assert.equal(stopped.statusReason, "worker_unresponsive");
  assert.equal(stopped.leaseId, undefined);
  assert.ok(setup.vultr.calls.includes("halt"));
});

Deno.test("D6 records one ServerControl completion for a server_suspend operation", async () => {
  const setup = fixture();
  const create = await setup.service.create(
    accountId,
    { plan: "vc2-2c-4gb" },
    {
      idempotencyKey: "admin-create",
      requestId: "admin-create",
    },
  );
  await setup.service.executeTask(accountId, create.taskId);
  const start = await setup.service.start(accountId, create.resource.id, {
    idempotencyKey: "admin-start",
    requestId: "admin-start",
  });
  await setup.service.executeTask(accountId, start.taskId);
  await setup.service.handleWorkerEvent(workerHealthy);

  const completion = await setup.service.handleAdminOperation(accountId, {
    ...adminSuspend,
    target: { resourceType: "server", resourceId: create.resource.id },
  });
  assert.equal(completion.eventType, "admin.operation.completed.v1");
  assert.equal(completion.owner, "m4");
  assert.equal(completion.status, "succeeded");
  assert.deepEqual(
    await setup.service.handleAdminOperation(accountId, {
      ...adminSuspend,
      target: { resourceType: "server", resourceId: create.resource.id },
    }),
    completion,
  );
  assert.equal(
    (await setup.service.get(accountId, create.resource.id)).status,
    "suspended",
  );
});
