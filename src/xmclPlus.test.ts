import assert from "node:assert/strict";
import { Hono } from "hono";
import type { AccountRuntime } from "./accountRuntime.ts";
import { BillingService } from "./billing.ts";
import { MemoryBillingStore } from "./ledger.ts";
import { handleAccountError } from "./accountHttp.ts";
import { createXmclPlusRoutes } from "./routes/xmclPlus.ts";
import { SharedHostingService } from "./sharedHosting.ts";
import type { AppEnv } from "./types.ts";
import {
  allowanceSourceKey,
  XMCL_PLUS_OFFER,
  XMCL_PLUS_TRIAL,
  XmclPlusService,
} from "./xmclPlus.ts";

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
    async consume(accountId: string, aiUnits: number, turnEgressBytes: number) {
      const allowances = await plus.allowances(accountId);
      const source = allowances.sources[0];
      assert.ok(source);
      await store.transaction((state) => {
        state.allowanceUsage.set(allowanceSourceKey(source), {
          aiUnits,
          turnEgressBytes,
        });
      });
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

Deno.test("Together trial can be claimed once and grants only bounded TURN allowance", async () => {
  const f = fixture();
  assert.deepEqual(await f.plus.trialStatus("account_trial"), {
    status: "available",
    durationSeconds: XMCL_PLUS_TRIAL.durationSeconds,
    turnEgressBytes: XMCL_PLUS_TRIAL.turnEgressBytes,
  });

  const claimed = await f.plus.claimTrial({
    accountId: "account_trial",
    idempotencyKey: "claim-trial",
  });
  assert.equal(claimed.status, "active");
  assert.equal(claimed.claimedAt, "2026-08-12T00:00:00.000Z");
  assert.equal(claimed.expiresAt, "2026-08-19T00:00:00.000Z");
  assert.deepEqual(
    await f.plus.claimTrial({
      accountId: "account_trial",
      idempotencyKey: "another-request",
    }),
    claimed,
  );

  const allowances = await f.plus.allowances("account_trial");
  assert.equal(allowances.aiUnits.included, 0);
  assert.equal(
    allowances.turnEgressBytes.included,
    XMCL_PLUS_TRIAL.turnEgressBytes,
  );
  assert.equal(allowances.sources[0]?.source, "trial");

  f.setNow("2026-08-19T00:00:00.000Z");
  assert.equal((await f.plus.trialStatus("account_trial")).status, "expired");
  assert.equal((await f.plus.allowances("account_trial")).sources.length, 0);
});

Deno.test("Together trial routes require account write scope and expose the claimed state", async () => {
  const f = fixture();
  const runtime = {
    sessions: {
      verify: async (token: string) => ({
        sessionId: `session_${token}`,
        familyId: `family_${token}`,
        accountId: "account_route_trial",
        scopes: token === "writer"
          ? ["account:read", "account:write"]
          : ["account:read"],
        issuedAt: "2026-08-12T00:00:00.000Z",
        expiresAt: "2026-08-12T01:00:00.000Z",
      }),
    },
  } as AccountRuntime;
  const app = new Hono<AppEnv>();
  app.onError(handleAccountError);
  app.route(
    "/",
    createXmclPlusRoutes(f.plus, () => Promise.resolve(runtime)),
  );

  assert.equal((await app.request("/v1/xmcl-plus/trial")).status, 401);
  assert.equal(
    (await app.request("/v1/xmcl-plus/trial", {
      method: "POST",
      headers: {
        authorization: "Bearer reader",
        "idempotency-key": "claim",
      },
    })).status,
    403,
  );
  const claimed = await app.request("/v1/xmcl-plus/trial", {
    method: "POST",
    headers: {
      authorization: "Bearer writer",
      "idempotency-key": "claim",
    },
  });
  assert.equal(claimed.status, 201);
  assert.equal((await claimed.json() as { status: string }).status, "active");

  const status = await app.request("/v1/xmcl-plus/trial", {
    headers: { authorization: "Bearer reader" },
  });
  assert.equal(status.status, 200);
  assert.equal((await status.json() as { status: string }).status, "active");
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

Deno.test("every active shared hosting subscription contributes a distinct allowance source", async () => {
  const f = fixture();
  await f.credit("account_multiple_servers", 800);
  const first = await f.shared.subscribe({
    accountId: "account_multiple_servers",
    planId: "shared-small",
    idempotencyKey: "first-server",
  });
  f.setNow("2026-08-20T00:00:00.000Z");
  const second = await f.shared.subscribe({
    accountId: "account_multiple_servers",
    planId: "shared-small",
    idempotencyKey: "second-server",
  });

  const allowances = await f.plus.allowances("account_multiple_servers");
  assert.equal(allowances.sources.length, 2);
  assert.equal(
    allowances.aiUnits.included,
    2 * XMCL_PLUS_OFFER.serverAiUnitsPerPeriod,
  );
  assert.equal(allowances.turnEgressBytes.included, 0);
  assert.deepEqual(
    allowances.sources.map((source) => ({
      source: source.source,
      referenceId: source.referenceId,
      periodEndsAt: source.periodEndsAt,
    })),
    [
      {
        source: "shared_hosting",
        referenceId: first.subscriptionId,
        periodEndsAt: first.currentPeriodEndsAt,
      },
      {
        source: "shared_hosting",
        referenceId: second.subscriptionId,
        periodEndsAt: second.currentPeriodEndsAt,
      },
    ],
  );
  assert.notEqual(first.currentPeriodEndsAt, second.currentPeriodEndsAt);
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

Deno.test("Plus renewal resets the active allowance period without carrying usage forward", async () => {
  const f = fixture();
  await f.credit("account_reset", 598);
  const subscription = await f.plus.subscribe({
    accountId: "account_reset",
    idempotencyKey: "subscribe",
  });
  const before = await f.plus.allowances("account_reset");
  assert.equal(before.aiUnits.remaining, XMCL_PLUS_OFFER.aiUnitsPerPeriod);
  await f.consume("account_reset", 125_000, 2_000_000_000);
  const consumed = await f.plus.allowances("account_reset");
  assert.equal(consumed.aiUnits.consumed, 125_000);
  assert.equal(consumed.turnEgressBytes.consumed, 2_000_000_000);

  f.setNow(subscription.currentPeriodEndsAt);
  assert.deepEqual(await f.plus.renewDue(), {
    renewed: [subscription.subscriptionId],
    paymentDue: [],
    cancelled: [],
  });
  const renewed = await f.plus.allowances("account_reset");
  assert.equal(renewed.aiUnits.included, XMCL_PLUS_OFFER.aiUnitsPerPeriod);
  assert.equal(renewed.aiUnits.consumed, 0);
  assert.equal(renewed.aiUnits.remaining, XMCL_PLUS_OFFER.aiUnitsPerPeriod);
  assert.equal(
    renewed.turnEgressBytes.remaining,
    XMCL_PLUS_OFFER.turnEgressBytesPerPeriod,
  );
  assert.notEqual(
    renewed.sources[0]?.periodStartedAt,
    before.sources[0]?.periodStartedAt,
  );
});

Deno.test("late Plus renewal charges once and starts a current period", async () => {
  const f = fixture();
  await f.credit("account_late", 598);
  const subscription = await f.plus.subscribe({
    accountId: "account_late",
    idempotencyKey: "subscribe",
  });
  f.setNow("2026-12-20T00:00:00.000Z");

  assert.deepEqual(await f.plus.renewDue(), {
    renewed: [subscription.subscriptionId],
    paymentDue: [],
    cancelled: [],
  });
  const renewed = await f.plus.status("account_late");
  assert.equal(renewed?.currentPeriodStartedAt, "2026-12-20T00:00:00.000Z");
  assert.equal(renewed?.currentPeriodEndsAt, "2027-01-20T00:00:00.000Z");
  assert.equal(
    (await f.billing.balance("account_late")).available.amountMinor,
    0,
  );
  assert.deepEqual(await f.plus.renewDue(), {
    renewed: [],
    paymentDue: [],
    cancelled: [],
  });
});
