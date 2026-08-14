import assert from "node:assert/strict";
import { AllowanceMeter } from "./allowanceMetering.ts";
import { BillingService } from "./billing.ts";
import { MemoryBillingStore } from "./ledger.ts";
import { XMCL_PLUS_OFFER, XmclPlusService } from "./xmclPlus.ts";

Deno.test("Together Home release lifecycle remains internally consistent", async () => {
  let now = new Date("2026-08-14T00:00:00.000Z");
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
  const meter = new AllowanceMeter(store, () => now);
  const credit = (accountId: string, amountMinor: number) =>
    billing.applyAdminOperation({
      operationId: `credit_${accountId}_${++sequence}`,
      action: "balance_adjust",
      accountId,
      amountMinor,
      reason: "Home release fixture",
    });

  await credit("account_cancel", 598);
  const cancelled = await plus.subscribe({
    accountId: "account_cancel",
    idempotencyKey: "subscribe",
  });
  assert.equal(
    (await billing.balance("account_cancel")).available.amountMinor,
    299,
  );
  assert.equal(
    await meter.reserveAi("account_cancel", "authorization_1", 1_000),
    true,
  );
  const settlement = await meter.settleAi(
    "authorization_1",
    "usage_1",
    {
      promptTokens: 500,
      cachedPromptTokens: 100,
      completionTokens: 50,
    },
  );
  assert.equal(settlement.weightedUnits, 610);
  assert.equal((await plus.allowances("account_cancel")).aiUnits.consumed, 610);
  await plus.cancel("account_cancel", "cancel");

  now = new Date(cancelled.currentPeriodEndsAt);
  assert.deepEqual(await plus.renewDue(now), {
    renewed: [],
    paymentDue: [],
    cancelled: [cancelled.subscriptionId],
  });
  assert.equal((await plus.allowances("account_cancel")).aiUnits.included, 0);
  assert.equal(
    (await billing.balance("account_cancel")).available.amountMinor,
    299,
  );

  now = new Date("2026-08-14T00:00:00.000Z");
  await credit("account_recovery", XMCL_PLUS_OFFER.monthlyPriceMinor);
  const paymentDue = await plus.subscribe({
    accountId: "account_recovery",
    idempotencyKey: "subscribe",
  });
  now = new Date(paymentDue.currentPeriodEndsAt);
  assert.deepEqual(await plus.renewDue(now), {
    renewed: [],
    paymentDue: [paymentDue.subscriptionId],
    cancelled: [],
  });
  assert.equal((await plus.allowances("account_recovery")).aiUnits.included, 0);

  await credit("account_recovery", XMCL_PLUS_OFFER.monthlyPriceMinor);
  assert.deepEqual(await plus.recoverPaymentDue("account_recovery", now), [
    paymentDue.subscriptionId,
  ]);
  const recovered = await plus.allowances("account_recovery");
  assert.equal(recovered.aiUnits.consumed, 0);
  assert.equal(recovered.aiUnits.remaining, XMCL_PLUS_OFFER.aiUnitsPerPeriod);
  assert.equal(
    recovered.turnEgressBytes.remaining,
    XMCL_PLUS_OFFER.turnEgressBytesPerPeriod,
  );
});
