import assert from "node:assert/strict";
import { Hono } from "hono";
import type { AccountRuntime } from "../lib/accountRuntime.ts";
import { BillingService } from "../lib/billing.ts";
import { MemoryBillingStore } from "../lib/ledger.ts";
import { SharedHostingService } from "../lib/sharedHosting.ts";
import type { AppEnv } from "../types.ts";
import { createSharedHostingRoutes } from "./sharedHosting.ts";

const store = new MemoryBillingStore();
const billing = new BillingService(store, { currency: "USD", rates: [] });
const shared = new SharedHostingService(store);
await billing.applyAdminOperation({
  operationId: "shared-route-credit",
  action: "balance_adjust",
  accountId: "account_1",
  amountMinor: 1_000,
  reason: "test credit",
});

const runtime = {
  sessions: {
    verify: async () => {
      return {
        accountId: "account_1",
        scopes: ["account:read", "account:write"],
      };
    },
  },
} as unknown as AccountRuntime;

const app = new Hono<AppEnv>();
app.route(
  "/",
  createSharedHostingRoutes(shared, () => Promise.resolve(runtime)),
);

Deno.test("shared hosting routes list catalog and create an authenticated subscription", async () => {
  const headers = {
    authorization: `Bearer ${"session"}`,
    "content-type": "application/json",
  };
  const plans = await app.request("/v1/shared-hosting/plans", { headers });
  assert.equal(plans.status, 200);
  assert.equal((await plans.json()).length, 3);

  const created = await app.request("/v1/shared-hosting/subscriptions", {
    method: "POST",
    headers: { ...headers, "idempotency-key": "route-subscribe" },
    body: JSON.stringify({ planId: "shared-small" }),
  });
  assert.equal(created.status, 201);
  const subscription = await created.json();
  assert.equal(subscription.plan.planId, "shared-small");

  const listed = await app.request("/v1/shared-hosting/subscriptions", {
    headers,
  });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).length, 1);
});
