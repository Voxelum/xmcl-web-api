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
): PublicSharedHostingSubscription {
  const plan = {
    "shared-small": {
      planId: "shared-small" as const,
      displayName: "Small",
      memoryMiB: 4096,
      sharedCpu: 2,
      burstCpu: 4,
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
      burstCpu: 6,
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
      burstCpu: 8,
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
    status: "active",
    currentPeriodStartedAt: "2026-07-24T00:00:00.000Z",
    currentPeriodEndsAt: "2026-08-24T00:00:00.000Z",
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    plan,
  };
}

function fixture() {
  let sequence = 0;
  const commands: SharedNodeCommand[] = [];
  const requests: unknown[] = [];
  const subscriptions = new Map<string, PublicSharedHostingSubscription>();
  const scheduler = new SharedHostingScheduler(
    new MemorySharedHostingSchedulerRepository(),
    {
      activeSubscription: async (accountId, subscriptionId) => {
        const value = subscriptions.get(subscriptionId);
        if (!value || value.accountId !== accountId) {
          throw new Error("subscription not found");
        }
        return value;
      },
    },
    { dispatch: async (command) => void commands.push(command) },
    { requestCapacity: async (request) => void requests.push(request) },
    {
      region: "sgp",
      now: () => new Date("2026-07-24T00:00:00.000Z"),
      createId: (prefix) => `${prefix}_${++sequence}`,
    },
  );
  return { scheduler, commands, requests, subscriptions };
}

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
});

Deno.test("shared scheduler fails closed for a durable node outside its configured pool region", async () => {
  const repository = new MemorySharedHostingSchedulerRepository();
  const scheduler = new SharedHostingScheduler(
    repository,
    { activeSubscription: async () => { throw new Error("unused"); } },
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
    () => scheduler.registerNode({
      nodeId: "stale-node",
      region: "sgp",
      status: "ready",
      totalMemoryMiB: 4096,
      totalSharedCpu: 2,
      totalWorkspaceGiB: 32,
    }),
  );
});
