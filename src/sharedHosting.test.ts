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
  assert.equal("burstCpu" in subscription.plan, false);
  assert.equal("burstCpu" in f.shared.listPlans()[0], false);
  assert.equal(subscription.status, "active");
  assert.equal(subscription.regionId, "sgp");
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

Deno.test("shared hosting validates the selected region against the enabled catalog", async () => {
  const f = fixture();
  await f.credit("account_region", 800);
  await assert.rejects(
    () =>
      f.shared.subscribe({
        accountId: "account_region",
        planId: "shared-small",
        regionId: "nrt",
        idempotencyKey: "unsupported-region",
      }),
    (error: unknown) =>
      error instanceof Error && error.message === "shared_region_not_available",
  );
  assert.equal(
    (await f.billing.balance("account_region")).available.amountMinor,
    800,
  );
});

Deno.test("shared hosting allows multiple active subscriptions per account", async () => {
  const f = fixture();
  await f.credit("account_multiple", 1_200);

  const first = await f.shared.subscribe({
    accountId: "account_multiple",
    planId: "shared-small",
    idempotencyKey: "first",
  });
  const second = await f.shared.subscribe({
    accountId: "account_multiple",
    planId: "shared-small",
    idempotencyKey: "second",
  });

  assert.notEqual(first.subscriptionId, second.subscriptionId);
  assert.deepEqual(
    (await f.shared.subscriptions("account_multiple")).map((item) =>
      item.status
    ),
    ["active", "active"],
  );
  assert.equal(
    (await f.billing.balance("account_multiple")).available.amountMinor,
    400,
  );
  assert.equal(
    (await f.billing.ledger("account_multiple")).filter((entry) =>
      entry.kind === "shared_base_fee"
    ).length,
    2,
  );
});

Deno.test("shared hosting allows a new subscription while another is payment due", async () => {
  const f = fixture();
  await f.credit("account_due_and_active", 400);
  const due = await f.shared.subscribe({
    accountId: "account_due_and_active",
    planId: "shared-small",
    idempotencyKey: "due",
  });

  f.setNow("2026-08-24T00:00:00.000Z");
  assert.deepEqual(await f.shared.renewDue(), {
    renewed: [],
    paymentDue: [due.subscriptionId],
    cancelled: [],
  });
  await f.credit("account_due_and_active", 400);
  const active = await f.shared.subscribe({
    accountId: "account_due_and_active",
    planId: "shared-small",
    idempotencyKey: "active",
  });

  assert.deepEqual(
    (await f.shared.subscriptions("account_due_and_active")).map((item) => [
      item.subscriptionId,
      item.status,
    ]),
    [
      [due.subscriptionId, "payment_due"],
      [active.subscriptionId, "active"],
    ],
  );
});

Deno.test("concurrent shared hosting subscriptions preserve idempotency and independent charges", async () => {
  const f = fixture();
  await f.credit("account_concurrent", 1_200);
  const input = {
    accountId: "account_concurrent",
    planId: "shared-small",
    idempotencyKey: "same",
  };

  const [first, replay] = await Promise.all([
    f.shared.subscribe(input),
    f.shared.subscribe(input),
  ]);
  assert.equal(replay.subscriptionId, first.subscriptionId);

  const [second, third] = await Promise.all([
    f.shared.subscribe({ ...input, idempotencyKey: "second" }),
    f.shared.subscribe({ ...input, idempotencyKey: "third" }),
  ]);
  assert.notEqual(second.subscriptionId, third.subscriptionId);
  assert.equal((await f.shared.subscriptions("account_concurrent")).length, 3);
  assert.equal(
    (await f.billing.balance("account_concurrent")).available.amountMinor,
    0,
  );
  assert.equal(
    (await f.billing.ledger("account_concurrent")).filter((entry) =>
      entry.kind === "shared_base_fee"
    ).length,
    3,
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
  assert.equal(
    (await f.shared.subscriptions("account_cancel"))[0].cancelledAt,
    "2026-08-24T00:00:00.000Z",
  );
  assert.equal(
    (await f.shared.subscriptions("account_cancel"))[0].retentionEndsAt,
    "2026-09-23T00:00:00.000Z",
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

Deno.test("a sufficient top-up recovers monthly and runtime payment-due subscriptions", async () => {
  const monthly = fixture();
  await monthly.credit("account_monthly_recovery", 400);
  const monthlySubscription = await monthly.shared.subscribe({
    accountId: "account_monthly_recovery",
    planId: "shared-small",
    idempotencyKey: "monthly-recovery-subscribe",
  });

  monthly.setNow("2026-08-24T00:00:00.000Z");
  assert.deepEqual(await monthly.shared.renewDue(), {
    renewed: [],
    paymentDue: [monthlySubscription.subscriptionId],
    cancelled: [],
  });
  await monthly.credit("account_monthly_recovery", 400);
  assert.deepEqual(
    await monthly.shared.recoverPaymentDue("account_monthly_recovery"),
    [monthlySubscription.subscriptionId],
  );
  assert.equal(
    (await monthly.shared.subscriptions("account_monthly_recovery"))[0].status,
    "active",
  );
  assert.equal(
    (await monthly.billing.balance("account_monthly_recovery")).available
      .amountMinor,
    0,
  );

  const runtime = fixture();
  await runtime.credit("account_runtime_recovery", 406);
  const runtimeSubscription = await runtime.shared.subscribe({
    accountId: "account_runtime_recovery",
    planId: "shared-small",
    idempotencyKey: "runtime-recovery-subscribe",
  });
  const settlement = (settledAt: string, settledHours: number) =>
    runtime.shared.settleRuntime({
      accountId: "account_runtime_recovery",
      serviceId: "service_recovery",
      subscriptionId: runtimeSubscription.subscriptionId,
      planId: "shared-small",
      assignmentId: "assignment_recovery",
      startedAt: "2026-07-24T00:00:00.000Z",
      settledHours,
      settledAt,
    });
  assert.equal(
    (await settlement("2026-07-24T00:00:00.000Z", 0)).status,
    "settled",
  );
  assert.equal(
    (await settlement("2026-07-24T01:01:00.000Z", 1)).status,
    "payment_due",
  );
  await runtime.credit("account_runtime_recovery", 12);
  assert.deepEqual(
    await runtime.shared.recoverPaymentDue(
      "account_runtime_recovery",
      new Date("2026-07-24T01:02:00.000Z"),
    ),
    [runtimeSubscription.subscriptionId],
  );
  assert.deepEqual(
    await settlement("2026-07-24T02:01:00.000Z", 2),
    {
      status: "settled",
      chargedHours: 3,
      amountMinor: 6,
      rateVersion: 101,
    },
  );
  assert.equal(
    (await runtime.billing.balance("account_runtime_recovery")).available
      .amountMinor,
    0,
  );
  assert.equal(
    (await runtime.billing.ledger("account_runtime_recovery")).filter((entry) =>
      entry.kind === "shared_runtime_fee"
    ).reduce((total, entry) => total + entry.amount.amountMinor, 0),
    18,
  );
});

Deno.test("first-hour runtime arrears recovery creates a settlement watermark", async () => {
  const f = fixture();
  await f.credit("account_first_hour_recovery", 400);
  const subscription = await f.shared.subscribe({
    accountId: "account_first_hour_recovery",
    planId: "shared-small",
    idempotencyKey: "first-hour-recovery-subscribe",
  });
  const settle = (settledAt: string, settledHours: number) =>
    f.shared.settleRuntime({
      accountId: "account_first_hour_recovery",
      serviceId: "service_first_hour",
      subscriptionId: subscription.subscriptionId,
      planId: "shared-small",
      assignmentId: "assignment_first_hour",
      startedAt: "2026-07-24T00:00:00.000Z",
      settledHours,
      settledAt,
    });
  assert.equal(
    (await settle("2026-07-24T00:01:00.000Z", 0)).status,
    "payment_due",
  );
  await f.credit("account_first_hour_recovery", 12);
  assert.deepEqual(
    await f.shared.recoverPaymentDue("account_first_hour_recovery"),
    [subscription.subscriptionId],
  );
  assert.deepEqual(await settle("2026-07-24T01:01:00.000Z", 0), {
    status: "settled",
    chargedHours: 2,
    amountMinor: 6,
    rateVersion: 101,
  });
  assert.equal(
    (await f.billing.balance("account_first_hour_recovery")).available
      .amountMinor,
    0,
  );
});

Deno.test("payment-due recovery settles runtime arrears and renewal together", async () => {
  const f = fixture();
  await f.credit("account_combined_recovery", 400);
  const subscription = await f.shared.subscribe({
    accountId: "account_combined_recovery",
    planId: "shared-small",
    idempotencyKey: "combined-recovery-subscribe",
  });
  const charge = await f.shared.settleRuntime({
    accountId: "account_combined_recovery",
    serviceId: "service_combined",
    subscriptionId: subscription.subscriptionId,
    planId: "shared-small",
    assignmentId: "assignment_combined",
    startedAt: "2026-07-24T00:00:00.000Z",
    settledHours: 0,
    settledAt: "2026-07-24T00:01:00.000Z",
  });
  assert.equal(charge.status, "payment_due");
  await f.credit("account_combined_recovery", 406);
  assert.deepEqual(
    await f.shared.recoverPaymentDue(
      "account_combined_recovery",
      new Date("2026-08-24T00:01:00.000Z"),
    ),
    [subscription.subscriptionId],
  );
  assert.equal(
    (await f.billing.balance("account_combined_recovery")).available
      .amountMinor,
    0,
  );
  assert.equal(
    (await f.shared.subscriptions("account_combined_recovery"))[0].status,
    "active",
  );
});

Deno.test("payment-due recovery honors cancellation at period end", async () => {
  const f = fixture();
  await f.credit("account_due_cancel", 400);
  const subscription = await f.shared.subscribe({
    accountId: "account_due_cancel",
    planId: "shared-small",
    idempotencyKey: "due-cancel-subscribe",
  });
  f.setNow("2026-08-24T00:00:00.000Z");
  assert.deepEqual(await f.shared.renewDue(), {
    renewed: [],
    paymentDue: [subscription.subscriptionId],
    cancelled: [],
  });
  await f.shared.cancel(
    "account_due_cancel",
    subscription.subscriptionId,
    "cancel-payment-due",
  );
  await f.credit("account_due_cancel", 400);
  assert.deepEqual(
    await f.shared.recoverPaymentDue("account_due_cancel"),
    [],
  );
  assert.equal(
    (await f.shared.subscriptions("account_due_cancel"))[0].status,
    "cancelled",
  );
  assert.equal(
    (await f.billing.balance("account_due_cancel")).available.amountMinor,
    400,
  );
});

Deno.test("period-end cancellation collects runtime arrears without renewing", async () => {
  const f = fixture();
  await f.credit("account_arrears_cancel", 400);
  const subscription = await f.shared.subscribe({
    accountId: "account_arrears_cancel",
    planId: "shared-small",
    idempotencyKey: "arrears-cancel-subscribe",
  });
  assert.equal(
    (await f.shared.settleRuntime({
      accountId: "account_arrears_cancel",
      serviceId: "service_arrears_cancel",
      subscriptionId: subscription.subscriptionId,
      planId: "shared-small",
      assignmentId: "assignment_arrears_cancel",
      startedAt: "2026-07-24T00:00:00.000Z",
      settledHours: 0,
      settledAt: "2026-07-24T00:01:00.000Z",
    })).status,
    "payment_due",
  );
  await f.shared.cancel(
    "account_arrears_cancel",
    subscription.subscriptionId,
    "cancel-with-arrears",
  );
  await f.credit("account_arrears_cancel", 6);
  assert.deepEqual(
    await f.shared.recoverPaymentDue(
      "account_arrears_cancel",
      new Date("2026-08-24T00:01:00.000Z"),
    ),
    [],
  );
  assert.equal(
    (await f.shared.subscriptions("account_arrears_cancel"))[0].status,
    "cancelled",
  );
  assert.equal(
    (await f.billing.balance("account_arrears_cancel")).available.amountMinor,
    0,
  );
});
