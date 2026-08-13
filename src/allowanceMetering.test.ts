import assert from "node:assert/strict";
import {
  AllowanceMeter,
  weightedAiUnits,
} from "./allowanceMetering.ts";
import { MemoryBillingStore } from "./ledger.ts";
import { XMCL_PLUS_OFFER, XmclPlusService } from "./xmclPlus.ts";

const now = new Date("2026-08-12T00:00:00.000Z");

async function plusFixture() {
  const store = new MemoryBillingStore();
  await store.transaction((state) => {
    state.plusSubscriptions.set("plus_1", {
      subscriptionId: "plus_1",
      accountId: "account",
      status: "active",
      currentPeriodStartedAt: "2026-08-01T00:00:00.000Z",
      currentPeriodEndsAt: "2026-09-01T00:00:00.000Z",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
  });
  return {
    store,
    meter: new AllowanceMeter(store, () => now),
    plus: new XmclPlusService(store, { now: () => now }),
  };
}

Deno.test("weighted AI usage applies cache and output multipliers", () => {
  assert.equal(weightedAiUnits({
    promptTokens: 100,
    cachedPromptTokens: 40,
    completionTokens: 20,
  }), 144);
});

Deno.test("AI allowance reservations are atomic, settled, and idempotent", async () => {
  const { meter, plus } = await plusFixture();
  assert.equal(await meter.reserveAi("account", "auth_1", 1_999_900), true);
  assert.equal(await meter.reserveAi("account", "auth_2", 101), false);

  const usage = {
    promptTokens: 100,
    cachedPromptTokens: 40,
    completionTokens: 20,
  };
  const first = await meter.settleAi("auth_1", "usage_1", usage);
  const replay = await meter.settleAi("auth_1", "usage_1", usage);
  assert.deepEqual(replay, first);

  const allowances = await plus.allowances("account");
  assert.equal(allowances.aiUnits.included, XMCL_PLUS_OFFER.aiUnitsPerPeriod);
  assert.equal(allowances.aiUnits.consumed, 144);
  assert.equal(
    allowances.aiUnits.remaining,
    XMCL_PLUS_OFFER.aiUnitsPerPeriod - 144,
  );
  assert.equal(allowances.aiUnits.meteringStatus, "active");
});

Deno.test("expired subscriptions cannot reserve AI allowance", async () => {
  const { store } = await plusFixture();
  const meter = new AllowanceMeter(
    store,
    () => new Date("2026-09-01T00:00:00.000Z"),
  );
  assert.equal(await meter.reserveAi("account", "auth_expired", 1), false);
});
