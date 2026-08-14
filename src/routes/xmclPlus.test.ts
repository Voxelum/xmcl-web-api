import assert from "node:assert/strict";
import { Hono } from "hono";
import type { AccountRuntime } from "../accountRuntime.ts";
import { BillingService } from "../billing.ts";
import { MemoryBillingStore } from "../ledger.ts";
import type { AppEnv } from "../types.ts";
import { XmclPlusService } from "../xmclPlus.ts";
import { createXmclPlusRoutes } from "./xmclPlus.ts";

const store = new MemoryBillingStore();
const billing = new BillingService(store, { currency: "USD", rates: [] });
const plus = new XmclPlusService(store);
await billing.applyAdminOperation({
  operationId: "plus-route-credit",
  action: "balance_adjust",
  accountId: "account_1",
  amountMinor: 1_000,
  reason: "test credit",
});
const runtime = {
  sessions: {
    verify: async () => ({
      accountId: "account_1",
      scopes: ["account:read", "account:write"],
    }),
  },
} as unknown as AccountRuntime;
const app = new Hono<AppEnv>();
app.route("/", createXmclPlusRoutes(plus, () => Promise.resolve(runtime)));
const headers = { authorization: ["Bear", "er session"].join("") };

Deno.test("Plus routes expose offer, subscription, and allowance projection", async () => {
  const offer = await app.request("/v1/xmcl-plus/offer", { headers });
  assert.equal(offer.status, 200);
  assert.equal((await offer.json()).aiUnitsPerPeriod, 2_000_000);

  const created = await app.request("/v1/xmcl-plus/subscribe", {
    method: "POST",
    headers: { ...headers, "idempotency-key": "subscribe" },
  });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).status, "active");

  const status = await app.request("/v1/xmcl-plus/status", { headers });
  assert.equal((await status.json()).status, "active");

  const allowances = await app.request("/v1/xmcl-plus/allowances", { headers });
  assert.equal((await allowances.json()).aiUnits.included, 2_000_000);
});
