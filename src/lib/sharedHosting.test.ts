import assert from "node:assert/strict";
import { BillingService } from "./billing.ts";
import { MemoryBillingStore } from "./ledger.ts";
import { SharedHostingService } from "./sharedHosting.ts";

function fixture() {
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
  return {
    billing,
    shared,
    setNow(value: string) {
      now = new Date(value);
    },
    async credit(accountId: string, amountMinor: number) {
      await billing.applyAdminOperation({
        operationId: `credit_${accountId}_${amountMinor}_${sequence}`,
        action: "balance_adjust",
        accountId,
        amountMinor,
        reason: "test credit",
      });
    },
  };
}

Deno.test("shared hosting subscription atomically charges its monthly base fee", async () => {
  const f = fixture();
  await f.credit("account_1", 1_000);

  const subscription = await f.shared.subscribe({
    accountId: "account_1",
    planId: "shared-small",
    idempotencyKey: "subscribe-small",
  });

  assert.equal(subscription.plan.monthlyBaseMinor, 400);
  assert.equal(subscription.plan.hourlyAmountMinor, 6);
  assert.equal(subscription.status, "active");
  assert.deepEqual(await f.billing.balance("account_1"), {
    accountId: "account_1",
    available: { currency: "USD", amountMinor: 600 },
    reserved: { currency: "USD", amountMinor: 0 },
  });
  assert.equal(
    (await f.billing.ledger("account_1")).filter((entry) =>
      entry.kind === "shared_base_fee"
    ).length,
    1,
  );

  const replay = await f.shared.subscribe({
    accountId: "account_1",
    planId: "shared-small",
    idempotencyKey: "subscribe-small",
  });
  assert.equal(replay.subscriptionId, subscription.subscriptionId);
  assert.equal(
    (await f.billing.ledger("account_1")).filter((entry) =>
      entry.kind === "shared_base_fee"
    ).length,
    1,
  );
});

Deno.test("shared hosting renews monthly, marks insufficient subscriptions payment due, and honors cancellation", async () => {
  const f = fixture();
  await f.credit("account_renew", 800);
  await f.credit("account_due", 400);
  await f.credit("account_cancel", 800);
  const renewing = await f.shared.subscribe({
    accountId: "account_renew",
    planId: "shared-small",
    idempotencyKey: "renew-subscribe",
  });
  const due = await f.shared.subscribe({
    accountId: "account_due",
    planId: "shared-small",
    idempotencyKey: "due-subscribe",
  });
  const cancelling = await f.shared.subscribe({
    accountId: "account_cancel",
    planId: "shared-small",
    idempotencyKey: "cancel-subscribe",
  });
  await f.shared.cancel(
    "account_cancel",
    cancelling.subscriptionId,
    "cancel-at-period-end",
  );

  f.setNow("2026-08-24T00:00:00.000Z");
  assert.deepEqual(await f.shared.renewDue(), {
    renewed: [renewing.subscriptionId],
    paymentDue: [due.subscriptionId],
    cancelled: [cancelling.subscriptionId],
  });
  assert.equal(
    (await f.shared.subscriptions("account_renew"))[0].status,
    "active",
  );
  assert.equal(
    (await f.shared.subscriptions("account_due"))[0].status,
    "payment_due",
  );
  assert.equal(
    (await f.shared.subscriptions("account_cancel"))[0].status,
    "cancelled",
  );
});

Deno.test("shared hosting exposes immutable hourly rate versions to the scheduler", () => {
  const f = fixture();
  assert.deepEqual(f.shared.runtimeRate("shared-medium"), {
    resource: "server_time",
    unit: "hour",
    rateVersion: 102,
    amountMinorPerHour: 9,
  });
});

Deno.test("shared hosting settles whole runtime hours idempotently at the plan rate", async () => {
  const f = fixture();
  await f.credit("account_runtime", 1_000);
  const subscription = await f.shared.subscribe({
    accountId: "account_runtime",
    planId: "shared-small",
    idempotencyKey: "runtime-subscribe",
  });

  const first = await f.shared.settleRuntime({
    accountId: "account_runtime",
    serviceId: "service_1",
    subscriptionId: subscription.subscriptionId,
    planId: "shared-small",
    assignmentId: "assignment_1",
    startedAt: "2026-07-24T00:00:00.000Z",
    settledHours: 0,
    settledAt: "2026-07-24T00:00:00.000Z",
  });
  assert.deepEqual(first, {
    status: "settled",
    chargedHours: 1,
    amountMinor: 6,
    rateVersion: 101,
  });

  const second = await f.shared.settleRuntime({
    accountId: "account_runtime",
    serviceId: "service_1",
    subscriptionId: subscription.subscriptionId,
    planId: "shared-small",
    assignmentId: "assignment_1",
    startedAt: "2026-07-24T00:00:00.000Z",
    settledHours: 1,
    settledAt: "2026-07-24T02:01:00.000Z",
  });
  assert.equal(second.chargedHours, 3);
  assert.equal(
    (await f.billing.ledger("account_runtime")).filter((entry) =>
      entry.kind === "shared_runtime_fee"
    ).length,
    3,
  );
  const replay = await f.shared.settleRuntime({
    accountId: "account_runtime",
    serviceId: "service_1",
    subscriptionId: subscription.subscriptionId,
    planId: "shared-small",
    assignmentId: "assignment_1",
    startedAt: "2026-07-24T00:00:00.000Z",
    settledHours: 1,
    settledAt: "2026-07-24T02:01:00.000Z",
  });
  assert.deepEqual(replay, second);
});
