import assert from "node:assert/strict";
import {
  MemorySharedHostingSchedulerRepository,
  SharedHostingScheduler,
  type SharedNodeCommand,
} from "./sharedHostingScheduler.ts";
import type { PublicSharedHostingSubscription } from "./sharedHosting.ts";

function subscription(
  accountId: string,
  subscriptionId: string,
  planId: PublicSharedHostingSubscription["planId"] = "shared-small",
  regionId?: string,
): PublicSharedHostingSubscription {
  const plan = {
    "shared-small": {
      planId: "shared-small" as const,
      displayName: "Small",
      memoryMiB: 4096,
      sharedCpu: 2,
      persistentStorageGiB: 32,
      monthlyBaseMinor: 400,
      hourlyRateVersion: 101,
      hourlyAmountMinor: 6,
    },
    "shared-medium": {
      planId: "shared-medium" as const,
      displayName: "Medium",
      memoryMiB: 6144,
      sharedCpu: 3,
      persistentStorageGiB: 48,
      monthlyBaseMinor: 600,
      hourlyRateVersion: 102,
      hourlyAmountMinor: 9,
    },
    "shared-large": {
      planId: "shared-large" as const,
      displayName: "Large",
      memoryMiB: 8192,
      sharedCpu: 4,
      persistentStorageGiB: 64,
      monthlyBaseMinor: 800,
      hourlyRateVersion: 103,
      hourlyAmountMinor: 12,
    },
  }[planId];
  return {
    subscriptionId,
    accountId,
    planId,
    regionId,
    status: "active",
    currentPeriodStartedAt: "2026-07-24T00:00:00.000Z",
    currentPeriodEndsAt: "2026-08-24T00:00:00.000Z",
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    plan,
  };
}

function fixture(
  regions: readonly string[] = ["sgp"],
  dispatchError?: Error,
) {
  let sequence = 0;
  const commands: SharedNodeCommand[] = [];
  const requests: Array<{ region: string; workloadClass: string }> = [];
  const subscriptions = new Map<string, PublicSharedHostingSubscription>();
  const repository = new MemorySharedHostingSchedulerRepository();
  const scheduler = new SharedHostingScheduler(
    repository,
    {
      activeSubscription: async (accountId, subscriptionId) => {
        const value = subscriptions.get(subscriptionId);
        if (!value || value.accountId !== accountId) {
          throw new Error("subscription not found");
        }
        return value;
      },
    },
    {
      dispatch: async (command) => {
        if (dispatchError) throw dispatchError;
        commands.push(command);
      },
    },
    { requestCapacity: async (request) => void requests.push(request) },
    {
      region: "sgp",
      regions,
      now: () => new Date("2026-07-24T00:00:00.000Z"),
      createId: (prefix) => `${prefix}_${++sequence}`,
    },
  );
  return { scheduler, repository, commands, requests, subscriptions };
}

Deno.test("failed start dispatch releases the incomplete assignment", async () => {
  const f = fixture(["sgp"], new Error("outbox unavailable"));
  f.subscriptions.set("sub_1", subscription("account_1", "sub_1"));
  await f.scheduler.registerNode({
    nodeId: "node_1",
    region: "sgp",
    status: "ready",
    totalMemoryMiB: 4096,
    totalSharedCpu: 2,
    totalWorkspaceGiB: 32,
  });
  const service = await f.scheduler.createService({
    accountId: "account_1",
    subscriptionId: "sub_1",
    idempotencyKey: "create",
  });
  await assert.rejects(
    () => f.scheduler.start("account_1", service.serviceId, "start"),
    /outbox unavailable/,
  );
  const recovered = await f.scheduler.getService(
    "account_1",
    service.serviceId,
  );
  assert.equal(recovered.status, "ready");
  assert.equal(recovered.statusReason, "command_dispatch_failed");
  assert.equal(recovered.nodeId, undefined);
  assert.equal(recovered.assignmentId, undefined);
});

Deno.test("failed retention deletion stays retained for reconciliation", async () => {
  const f = fixture();
  await f.repository.transact((state) => {
    state.services.push({
      serviceId: "service_retained",
      accountId: "account_1",
      subscriptionId: "subscription_1",
      planId: "shared-small",
      regionId: "sgp",
      status: "retained",
      workspace: {
        objectPrefix: "shared-hosting/account_1/service_retained/",
        revision: 1,
        sizeBytes: 10,
      },
      retentionStartedAt: "2026-06-23T00:00:00.000Z",
      retentionEndsAt: "2026-07-23T00:00:00.000Z",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-23T00:00:00.000Z",
    });
  });
  f.scheduler.attachRetentionPurger(async () => {
    throw new Error("provider outcome unknown");
  });
  assert.deepEqual(await f.scheduler.purgeExpiredRetentions(), {
    deleted: [],
    failed: ["service_retained"],
  });
  assert.equal((await f.repository.read()).services[0].status, "retained");
});

Deno.test("shared scheduler keeps services inside their selected regional pool", async () => {
  const f = fixture(["sgp", "nrt"]);
  f.subscriptions.set(
    "sub_nrt",
    subscription("account_nrt", "sub_nrt", "shared-small", "nrt"),
  );
  await f.scheduler.registerNode({
    nodeId: "node_sgp",
    region: "sgp",
    status: "ready",
    totalMemoryMiB: 4096,
    totalSharedCpu: 2,
    totalWorkspaceGiB: 32,
  });
  await f.scheduler.registerNode({
    nodeId: "node_nrt",
    region: "nrt",
    status: "ready",
    totalMemoryMiB: 4096,
    totalSharedCpu: 2,
    totalWorkspaceGiB: 32,
  });
  const service = await f.scheduler.createService({
    accountId: "account_nrt",
    subscriptionId: "sub_nrt",
    idempotencyKey: "create-nrt",
  });
  assert.equal(service.regionId, "nrt");
  const started = await f.scheduler.start(
    "account_nrt",
    service.serviceId,
    "start-nrt",
  );
  assert.equal(started.nodeId, "node_nrt");
  assert.equal(f.commands[0].nodeId, "node_nrt");

  f.subscriptions.set(
    "sub_nrt_2",
    subscription("account_nrt", "sub_nrt_2", "shared-small", "nrt"),
  );
  const queued = await f.scheduler.createService({
    accountId: "account_nrt",
    subscriptionId: "sub_nrt_2",
    idempotencyKey: "create-nrt-2",
  });
  assert.equal(
    (await f.scheduler.start("account_nrt", queued.serviceId, "start-nrt-2"))
      .status,
    "queued",
  );
  await f.scheduler.processCapacityRequests();
  assert.equal(f.requests[0].region, "nrt");
});

Deno.test("shared scheduler packs services into slots and queues without capacity", async () => {
  const f = fixture();
  f.subscriptions.set("sub_a", subscription("account_a", "sub_a"));
  f.subscriptions.set("sub_b", subscription("account_b", "sub_b"));
  await f.scheduler.registerNode({
    nodeId: "node_a",
    region: "sgp",
    status: "ready",
    totalMemoryMiB: 4096,
    totalSharedCpu: 2,
    totalWorkspaceGiB: 32,
  });

  const first = await f.scheduler.createService({
    accountId: "account_a",
    subscriptionId: "sub_a",
    idempotencyKey: "create_a",
  });
  const second = await f.scheduler.createService({
    accountId: "account_b",
    subscriptionId: "sub_b",
    idempotencyKey: "create_b",
  });

  const starting = await f.scheduler.start(
    "account_a",
    first.serviceId,
    "start_a",
  );
  assert.equal(starting.status, "starting");
  assert.equal(f.commands.length, 1);
  assert.equal(f.commands[0].kind, "workspace.restore_and_start");
  assert.equal(
    f.commands[0].workspace.objectPrefix,
    `shared-hosting/account_a/${first.serviceId}/`,
  );
  await f.scheduler.reportStarted({
    nodeId: "node_a",
    serviceId: first.serviceId,
    assignmentId: starting.assignmentId!,
  });

  const queued = await f.scheduler.start(
    "account_b",
    second.serviceId,
    "start_b",
  );
  assert.equal(queued.status, "queued");
  await f.scheduler.processCapacityRequests();
  assert.equal(f.requests.length, 1);
});

Deno.test("empty historical workspaces restore selected runtime as an initial workspace", async () => {
  const f = fixture();
  f.subscriptions.set("sub_a", subscription("account_a", "sub_a"));
  await f.scheduler.registerNode({
    nodeId: "node_a",
    region: "sgp",
    status: "ready",
    totalMemoryMiB: 4096,
    totalSharedCpu: 2,
    totalWorkspaceGiB: 32,
  });
  const created = await f.scheduler.createService({
    accountId: "account_a",
    subscriptionId: "sub_a",
    idempotencyKey: "create_a",
  });
  await f.repository.transact((state) => {
    const service = state.services.find((value) =>
      value.serviceId === created.serviceId
    )!;
    service.workspace = {
      ...service.workspace,
      revision: 1,
      sizeBytes: 0,
      physicalBytes: 0,
      sha256: "a".repeat(64),
      syncedAt: "2026-07-23T00:00:00.000Z",
    };
    service.runtimeContent = {
      deploymentId: "deployment_1",
      manifestSha256: "b".repeat(64),
      key:
        `shared-hosting/account_a/${created.serviceId}/compiler-content/content_1`,
      sha256: "c".repeat(64),
      compressedSize: 1,
      logicalSize: 1,
      paths: [".xmcl/runtime.json"],
      eulaAccepted: true,
    };
  });

  await f.scheduler.start("account_a", created.serviceId, "start_a");

  assert.equal(f.commands[0].workspace.revision, 0);
  assert.equal(f.commands[0].workspace.sha256, undefined);
  assert.equal(
    (await f.repository.read()).services[0].workspace.revision,
    1,
  );
  const stopping = await f.scheduler.stop(
    "account_a",
    created.serviceId,
    "stop_a",
  );
  assert.equal(await f.scheduler.reportStopped({
    nodeId: "node_a",
    serviceId: created.serviceId,
    assignmentId: stopping.assignmentId!,
  }), false);
  assert.equal(
    (await f.repository.read()).services[0].status,
    "ready",
  );
});

Deno.test("shared scheduler syncs stopped data to object storage and assigns the next queued service", async () => {
  const f = fixture();
  f.subscriptions.set("sub_a", subscription("account_a", "sub_a"));
  f.subscriptions.set("sub_b", subscription("account_b", "sub_b"));
  await f.scheduler.registerNode({
    nodeId: "node_a",
    region: "sgp",
    status: "ready",
    totalMemoryMiB: 4096,
    totalSharedCpu: 2,
    totalWorkspaceGiB: 32,
  });
  const first = await f.scheduler.createService({
    accountId: "account_a",
    subscriptionId: "sub_a",
    idempotencyKey: "create_a",
  });
  const second = await f.scheduler.createService({
    accountId: "account_b",
    subscriptionId: "sub_b",
    idempotencyKey: "create_b",
  });
  const running = await f.scheduler.start(
    "account_a",
    first.serviceId,
    "start_a",
  );
  await f.scheduler.reportStarted({
    nodeId: "node_a",
    serviceId: first.serviceId,
    assignmentId: running.assignmentId!,
  });
  await f.scheduler.start("account_b", second.serviceId, "start_b");

  const stopping = await f.scheduler.stop(
    "account_a",
    first.serviceId,
    "stop_a",
  );
  assert.equal(stopping.status, "stopping");
  const stopCommand = f.commands.at(-1)!;
  assert.equal(stopCommand.kind, "workspace.stop_and_sync");
  await f.scheduler.reportStopped({
    nodeId: "node_a",
    serviceId: first.serviceId,
    assignmentId: stopCommand.assignmentId,
  });
  await f.scheduler.reportStoppedAndSynced({
    nodeId: "node_a",
    serviceId: first.serviceId,
    assignmentId: stopCommand.assignmentId,
    workspace: {
      revision: 1,
      sizeBytes: 2_048,
      sha256: "a".repeat(64),
    },
  });

  const firstAfterStop = (await f.scheduler.listServices("account_a"))[0];
  assert.equal(firstAfterStop.status, "ready");
  assert.equal(firstAfterStop.nodeId, undefined);
  assert.equal(firstAfterStop.workspace.revision, 1);
  const secondAfterCapacity = (await f.scheduler.listServices("account_b"))[0];
  assert.equal(secondAfterCapacity.status, "starting");
  assert.equal(secondAfterCapacity.nodeId, "node_a");
  assert.equal(f.commands.at(-1)?.serviceId, second.serviceId);
});

Deno.test("shared scheduler never allocates a node that lacks workspace capacity", async () => {
  const f = fixture();
  f.subscriptions.set(
    "sub_large",
    subscription("account_a", "sub_large", "shared-large"),
  );
  await f.scheduler.registerNode({
    nodeId: "node_a",
    region: "sgp",
    status: "ready",
    totalMemoryMiB: 16384,
    totalSharedCpu: 8,
    totalWorkspaceGiB: 32,
  });

  const service = await f.scheduler.createService({
    accountId: "account_a",
    subscriptionId: "sub_large",
    idempotencyKey: "create_large",
  });
  const queued = await f.scheduler.start(
    "account_a",
    service.serviceId,
    "start_large",
  );
  assert.equal(queued.status, "queued");
  assert.equal(f.commands.length, 0);
});

Deno.test("shared scheduler requires a large-capable node for Village services", async () => {
  const f = fixture();
  f.subscriptions.set(
    "sub_large",
    subscription("account_a", "sub_large", "shared-large"),
  );
  await f.scheduler.registerNode({
    nodeId: "node_standard",
    region: "sgp",
    status: "ready",
    workloadClasses: ["standard"],
    totalMemoryMiB: 16384,
    totalSharedCpu: 8,
    totalWorkspaceGiB: 128,
  });

  const service = await f.scheduler.createService({
    accountId: "account_a",
    subscriptionId: "sub_large",
    idempotencyKey: "create_large_class",
  });
  assert.equal(
    (await f.scheduler.start(
      "account_a",
      service.serviceId,
      "start_large_class",
    )).status,
    "queued",
  );
  await f.scheduler.processCapacityRequests();
  assert.equal(f.requests[0].workloadClass, "large");

  await f.scheduler.registerNode({
    nodeId: "node_large",
    region: "sgp",
    status: "ready",
    workloadClasses: ["standard", "large"],
    totalMemoryMiB: 16384,
    totalSharedCpu: 8,
    totalWorkspaceGiB: 128,
  });
  assert.equal(
    (await f.scheduler.listServices("account_a"))[0].nodeId,
    "node_large",
  );
});

Deno.test("a draining node heartbeat prevents later placement until control-plane reconciliation", async () => {
  const repository = new MemorySharedHostingSchedulerRepository();
  const scheduler = new SharedHostingScheduler(
    repository,
    {
      activeSubscription: async () => {
        throw new Error("unused");
      },
    },
    { dispatch: async () => {} },
    undefined,
    { region: "sgp" },
  );
  await scheduler.registerNode({
    nodeId: "node_1",
    region: "sgp",
    status: "ready",
    totalMemoryMiB: 12 * 1024,
    totalSharedCpu: 8,
    totalWorkspaceGiB: 128,
  });

  await scheduler.heartbeatNode("node_1", "draining");
  await scheduler.heartbeatNode("node_1", "ready");

  assert.equal((await repository.read()).nodes[0]?.status, "draining");
  await scheduler.markNodeReady("node_1");
  assert.equal((await repository.read()).nodes[0]?.status, "ready");
});

Deno.test("shared scheduler fails closed for a durable node outside its configured pool region", async () => {
  const repository = new MemorySharedHostingSchedulerRepository();
  const scheduler = new SharedHostingScheduler(
    repository,
    {
      activeSubscription: async () => {
        throw new Error("unused");
      },
    },
    { dispatch: async () => {} },
    undefined,
    { region: "sgp" },
  );
  await repository.transact((state) => {
    state.nodes.push({
      nodeId: "stale-node",
      region: "ewr",
      status: "ready",
      totalMemoryMiB: 4096,
      totalSharedCpu: 2,
      totalWorkspaceGiB: 32,
      lastHeartbeatAt: "2026-07-24T00:00:00.000Z",
    });
  });

  assert.equal(await scheduler.hasNode("stale-node"), false);
  await assert.rejects(
    () =>
      scheduler.registerNode({
        nodeId: "stale-node",
        region: "sgp",
        status: "ready",
        totalMemoryMiB: 4096,
        totalSharedCpu: 2,
        totalWorkspaceGiB: 32,
      }),
  );
});
