import assert from "node:assert/strict";
import { BillingService } from "./billing.ts";
import { MemoryBillingStore } from "./ledger.ts";
import {
  MemorySharedHostingSchedulerRepository,
  SharedHostingScheduler,
} from "./sharedHostingScheduler.ts";
import { SharedHostingService } from "./sharedHosting.ts";
import { sharedHostingBillingWork } from "./sharedHostingScheduling.ts";

function fixture(
  initialCredit = 10_000,
  notifyStorageOverage?: (input: {
    accountId: string;
    serviceId: string;
    logicalBytes: number;
    physicalBytes: number;
    quotaBytes: number;
    graceEndsAt: string;
  }) => Promise<void>,
) {
  let now = new Date("2026-07-24T00:00:00.000Z");
  let sequence = 0;
  const store = new MemoryBillingStore();
  const billing = new BillingService(store, {
    currency: "USD",
    rates: [],
    now: () => now,
    createId: (prefix) => `${prefix}_${++sequence}`,
  });
  const shared = new SharedHostingService(store, {
    now: () => now,
    createId: (prefix) => `${prefix}_${++sequence}`,
  });
  const commands: unknown[] = [];
  const scheduler = new SharedHostingScheduler(
    new MemorySharedHostingSchedulerRepository(),
    shared,
    { dispatch: async (command) => void commands.push(command) },
    undefined,
    {
      region: "sgp",
      now: () => now,
      createId: (prefix) => `${prefix}_${++sequence}`,
      notifyStorageOverage,
    },
  );
  return {
    billing,
    shared,
    scheduler,
    commands,
    setNow(value: string) {
      now = new Date(value);
    },
    async credit() {
      await billing.applyAdminOperation({
        operationId: `credit_${sequence}`,
        action: "balance_adjust",
        accountId: "account_1",
        amountMinor: initialCredit,
        reason: "remediation test credit",
      });
    },
  };
}

async function runningFixture(
  initialCredit?: number,
  notifyStorageOverage?: Parameters<typeof fixture>[1],
) {
  const f = fixture(initialCredit, notifyStorageOverage);
  await f.credit();
  const subscription = await f.shared.subscribe({
    accountId: "account_1",
    planId: "shared-small",
    idempotencyKey: "subscribe",
  });
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
    subscriptionId: subscription.subscriptionId,
    idempotencyKey: "create",
  });
  const starting = await f.scheduler.start(
    "account_1",
    service.serviceId,
    "start",
  );
  await f.scheduler.reportStarted({
    nodeId: "node_1",
    serviceId: service.serviceId,
    assignmentId: starting.assignmentId!,
  });
  return { ...f, subscription, serviceId: service.serviceId };
}

Deno.test("periodic runtime settlement charges exactly five hours and retries safely", async () => {
  const f = await runningFixture();
  for (const hour of [1, 2, 3, 4]) {
    f.setNow(`2026-07-24T0${hour}:00:00.000Z`);
    await f.scheduler.settleRunningRuntime(
      new Date(`2026-07-24T0${hour}:00:00.000Z`),
    );
  }
  f.setNow("2026-07-24T05:00:00.000Z");
  await f.scheduler.settleRunningRuntime(new Date("2026-07-24T05:00:00.000Z"));
  await f.scheduler.settleRunningRuntime(new Date("2026-07-24T05:00:00.000Z"));

  const fees = (await f.billing.ledger("account_1")).filter((entry) =>
    entry.kind === "shared_runtime_fee"
  );
  assert.equal(fees.length, 5);
  assert.equal(
    fees.reduce((total, entry) => total + entry.amount.amountMinor, 0),
    30,
  );
});

Deno.test("runtime payment failure stops the service and blocks later starts", async () => {
  const f = await runningFixture(400);
  const stopping = (await f.scheduler.listServices("account_1"))[0];
  assert.equal(stopping.status, "stopping");
  assert.equal(f.commands.length, 2);
  assert.equal(
    (await f.shared.subscriptions("account_1"))[0].status,
    "payment_due",
  );
  await assert.rejects(
    () => f.scheduler.start("account_1", f.serviceId, "retry-start"),
    (error) =>
      error instanceof Error && "code" in error &&
      error.code === "shared_subscription_not_active",
  );
});

Deno.test("renewal payment failure enqueues one stop/sync command", async () => {
  const f = await runningFixture(800);
  f.setNow("2026-08-24T00:00:00.000Z");
  const result = await sharedHostingBillingWork(f.shared, f.scheduler).renewDue(
    new Date("2026-08-24T00:00:00.000Z"),
  );
  assert.deepEqual(result.paymentDue, [f.subscription.subscriptionId]);
  assert.equal(f.commands.length, 2);
});

Deno.test("storage overage notifies, preserves data, and blocks only after grace", async () => {
  const notices: unknown[] = [];
  const f = await runningFixture(10_000, async (input) => {
    notices.push(input);
  });
  const service = (await f.scheduler.listServices("account_1"))[0];
  await f.scheduler.stop("account_1", service.serviceId, "stop");
  const stopCommand = f.commands.at(-1) as {
    assignmentId: string;
  };
  const quotaBytes = 32 * 1024 ** 3;
  await f.scheduler.reportStoppedAndSynced({
    nodeId: "node_1",
    serviceId: service.serviceId,
    assignmentId: stopCommand.assignmentId,
    workspace: {
      revision: 1,
      sizeBytes: quotaBytes + 1,
      physicalBytes: quotaBytes + 2,
    },
  });
  const afterSync = (await f.scheduler.listServices("account_1"))[0];
  assert.equal(afterSync.workspace.sizeBytes, quotaBytes + 1);
  assert.equal(afterSync.storageGraceEndsAt, "2026-07-31T00:00:00.000Z");
  f.setNow("2026-08-01T00:00:00.000Z");
  await assert.rejects(
    () => f.scheduler.start("account_1", service.serviceId, "after-grace"),
    (error) =>
      error instanceof Error && "code" in error &&
      error.code === "shared_storage_over_quota",
  );
  assert.equal(
    (await f.scheduler.listServices("account_1"))[0].status,
    "ready",
  );
  assert.equal(notices.length, 1);
});
