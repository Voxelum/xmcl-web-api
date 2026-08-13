import assert from "node:assert/strict";
import { BillingService } from "./billing.ts";
import { MemoryBillingStore } from "./ledger.ts";
import { SharedHostingService } from "./sharedHosting.ts";
import { XMCL_PLUS_OFFER, XmclPlusService } from "./xmclPlus.ts";

function fixture() {
  let now = new Date("2026-08-12T00:00:00.000Z");
  let sequence = 0;
  const store = new MemoryBillingStore();
  const billing = new BillingService(store, {
    currency: "USD",
    rates: [],
    now: () => now,
    createId: (prefix) => `${prefix}_${++sequence}`,
  });
  const plus = new XmclPlusService(store, {
    now: () => now,
    createId: (prefix) => `${prefix}_${++sequence}`,
  });
  const shared = new SharedHostingService(store, {
    now: () => now,
    createId: (prefix) => `${prefix}_${++sequence}`,
  });
  return {
    billing,
    plus,
    shared,
    setNow(value: string) {
      now = new Date(value);
    },
    credit: (accountId: string, amountMinor: number) =>
      billing.applyAdminOperation({
        operationId: `credit_${accountId}_${sequence++}`,
        action: "balance_adjust",
        accountId,
        amountMinor,
        reason: "test credit",
      }),
  };
}

Deno.test("Plus subscription charges once and exposes provider-neutral allowances", async () => {
  const f = fixture();
  await f.credit("account_1", 1_000);
  const created = await f.plus.subscribe({
    accountId: "account_1",
    idempotencyKey: "subscribe",
  });
  const replay = await f.plus.subscribe({
    accountId: "account_1",
    idempotencyKey: "subscribe",
  });
  assert.equal(replay.subscriptionId, created.subscriptionId);
  assert.equal(
    (await f.billing.balance("account_1")).available.amountMinor,
    701,
  );
  assert.equal(
    (await f.billing.ledger("account_1")).filter((entry) =>
      entry.kind === "plus_base_fee"
    ).length,
    1,
  );
  assert.deepEqual(await f.plus.allowances("account_1"), {
    sources: [{
      source: "plus",
      referenceId: created.subscriptionId,
      aiUnits: 2_000_000,
      turnEgressBytes: 20_000_000_000,
      periodStartedAt: created.currentPeriodStartedAt,
      periodEndsAt: created.currentPeriodEndsAt,
    }],
    aiUnits: {
      included: 2_000_000,
      consumed: 0,
      remaining: 2_000_000,
      meteringStatus: "active",
    },
    turnEgressBytes: {
      included: 20_000_000_000,
      consumed: 0,
      remaining: 20_000_000_000,
      meteringStatus: "not_configured",
    },
  });
});

Deno.test("active shared hosting adds AI units but never TURN", async () => {
  const f = fixture();
  await f.credit("account_1", 2_000);
  await f.plus.subscribe({
    accountId: "account_1",
    idempotencyKey: "plus",
  });
  await f.shared.subscribe({
    accountId: "account_1",
    planId: "shared-small",
    idempotencyKey: "server",
  });
  const allowances = await f.plus.allowances("account_1");
  assert.equal(allowances.sources.length, 2);
  assert.equal(
    allowances.aiUnits.included,
    XMCL_PLUS_OFFER.aiUnitsPerPeriod +
      XMCL_PLUS_OFFER.serverAiUnitsPerPeriod,
  );
  assert.equal(
    allowances.turnEgressBytes.included,
    XMCL_PLUS_OFFER.turnEgressBytesPerPeriod,
  );
  assert.equal(
    allowances.sources.find((source) => source.source === "shared_hosting")
      ?.turnEgressBytes,
    0,
  );
});

Deno.test("Plus cancellation and insufficient renewal preserve monthly billing state", async () => {
  const f = fixture();
  await f.credit("account_cancel", 299);
  await f.credit("account_due", 299);
  await f.plus.subscribe({
    accountId: "account_cancel",
    idempotencyKey: "cancel-subscribe",
  });
  await f.plus.subscribe({
    accountId: "account_due",
    idempotencyKey: "due-subscribe",
  });
  await f.plus.cancel("account_cancel", "cancel");
  f.setNow("2026-09-12T00:00:00.000Z");
  assert.deepEqual(await f.plus.renewDue(), {
    renewed: [],
    paymentDue: [(await f.plus.status("account_due"))!.subscriptionId],
    cancelled: [(await f.plus.status("account_cancel"))!.subscriptionId],
  });
  assert.equal((await f.plus.status("account_cancel"))?.status, "cancelled");
  assert.equal((await f.plus.status("account_due"))?.status, "payment_due");
  assert.equal((await f.plus.allowances("account_due")).aiUnits.included, 0);
  await f.credit("account_due", 299);
  assert.equal((await f.plus.recoverPaymentDue("account_due")).length, 1);
  const recovered = await f.plus.status("account_due");
  assert.equal(recovered?.status, "active");
  assert.equal(recovered?.currentPeriodStartedAt, "2026-09-12T00:00:00.000Z");
  assert.equal(recovered?.currentPeriodEndsAt, "2026-10-12T00:00:00.000Z");
});
