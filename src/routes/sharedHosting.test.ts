import assert from "node:assert/strict";
import { Hono } from "hono";
import type { AccountRuntime } from "../accountRuntime.ts";
import { BillingService } from "../billing.ts";
import { MemoryBillingStore } from "../ledger.ts";
import { SharedHostingService } from "../sharedHosting.ts";
import {
  MemorySharedHostingSchedulerRepository,
  SharedHostingScheduler,
} from "../sharedHostingScheduler.ts";
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
const scheduler = new SharedHostingScheduler(
  new MemorySharedHostingSchedulerRepository(),
  shared,
  { dispatch: async () => {} },
  undefined,
  { region: "sgp" },
);
app.route(
  "/",
  createSharedHostingRoutes(
    shared,
    () => Promise.resolve(runtime),
    scheduler,
  ),
);

Deno.test("shared hosting routes list catalog and create an authenticated subscription", async () => {
  const headers = {
    authorization: `Bearer ${"session"}`,
    "content-type": "application/json",
  };
  const plans = await app.request("/v1/shared-hosting/plans", { headers });
  assert.equal(plans.status, 200);
  assert.equal((await plans.json()).length, 3);
  const regions = await app.request("/v1/shared-hosting/regions", { headers });
  assert.equal(regions.status, 200);
  assert.deepEqual(
    (await regions.json()).map((item: { regionId: string }) => item.regionId),
    ["sgp"],
  );

  const created = await app.request("/v1/shared-hosting/subscriptions", {
    method: "POST",
    headers: { ...headers, "idempotency-key": "route-subscribe" },
    body: JSON.stringify({ planId: "shared-small", regionId: "sgp" }),
  });
  assert.equal(created.status, 201);
  const subscription = await created.json();
  assert.equal(subscription.plan.planId, "shared-small");
  assert.equal(subscription.regionId, "sgp");
  const services = await scheduler.listServices("account_1");
  assert.equal(services.length, 1);
  assert.equal(services[0].subscriptionId, subscription.subscriptionId);
  assert.equal(services[0].regionId, "sgp");

  const listed = await app.request("/v1/shared-hosting/subscriptions", {
    headers,
  });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).length, 1);
});
