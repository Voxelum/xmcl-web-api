import assert from "node:assert/strict";
import type { Db } from "../db.ts";
import {
  createBillingRuntime,
  createSharedRuntimeSettlementWork,
  type BillingRuntime,
} from "./billingRuntime.ts";

const db = {
  collection() {
    return {};
  },
} as unknown as Db;

const rate = JSON.stringify([{
  rateVersion: 1,
  resource: "server_time",
  unit: "second",
  amountMinorPerUnit: 1,
  effectiveAt: "2026-07-24T00:00:00.000Z",
}]);

Deno.test("billing runtime defaults its settlement currency to USD", () => {
  const runtime = createBillingRuntime(db, { BILLING_RATES_JSON: rate });
  assert.equal(runtime.billing.settlementCurrency, "USD");
});

Deno.test("billing runtime accepts hour-priced server capacity", () => {
  const runtime = createBillingRuntime(db, {
    BILLING_RATES_JSON: JSON.stringify([{
      rateVersion: 2,
      resource: "server_time",
      unit: "hour",
      amountMinorPerUnit: 6,
      effectiveAt: "2026-07-24T00:00:00.000Z",
    }]),
  });

  assert.equal(
    runtime.billing.rate("server_time", "hour", 2).amountMinorPerUnit,
    6,
  );
});

Deno.test("billing runtime publishes the approved shared-hosting rate versions", () => {
  const runtime = createBillingRuntime(db, { BILLING_RATES_JSON: rate });
  assert.equal(
    runtime.billing.rate("server_time", "hour", 101).amountMinorPerUnit,
    6,
  );
  assert.equal(
    runtime.billing.rate("server_time", "hour", 102).amountMinorPerUnit,
    9,
  );
  assert.equal(
    runtime.billing.rate("server_time", "hour", 103).amountMinorPerUnit,
    12,
  );
});

Deno.test("billing runtime requires an explicit versioned rate table", () => {
  assert.throws(
    () => createBillingRuntime(db, {}),
    /BILLING_RATES_JSON must be configured/,
  );
  assert.throws(
    () => createBillingRuntime(db, { BILLING_RATES_JSON: "{}" }),
    /BILLING_RATES_JSON must be a JSON array/,
  );
});

Deno.test("billing runtime composes periodic renewal, payment-due stops, and runtime settlement", async () => {
  const calls: string[] = [];
  const work = createSharedRuntimeSettlementWork(
    {
      sharedHosting: {
        renewDue: async (at: Date) => {
          calls.push(`renew:${at.toISOString()}`);
          return {
            renewed: ["sub_renewed"],
            paymentDue: ["sub_due"],
            cancelled: [],
          };
        },
      },
    } as unknown as Pick<BillingRuntime, "sharedHosting">,
    {
      enforcePaymentDue: async (subscriptionIds) => {
        calls.push(`stop:${subscriptionIds.join(",")}`);
      },
      settleRunningRuntime: async (at) => {
        calls.push(`runtime:${at.toISOString()}`);
        return { settled: ["service_1"], paymentDue: ["service_2"] };
      },
    },
  );

  const result = await work.renewDue(new Date("2026-08-24T00:00:00.000Z"));
  assert.deepEqual(calls, [
    "renew:2026-08-24T00:00:00.000Z",
    "stop:sub_due",
    "runtime:2026-08-24T00:00:00.000Z",
  ]);
  assert.deepEqual(result.runtimeSettled, ["service_1"]);
  assert.deepEqual(result.runtimePaymentDue, ["service_2"]);
});
