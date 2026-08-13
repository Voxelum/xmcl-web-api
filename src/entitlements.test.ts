import assert from "node:assert/strict";
import { BillingEntitlementReader } from "./entitlements.ts";
import { MemoryBillingStore } from "./ledger.ts";

const now = new Date("2026-08-12T00:00:00.000Z");

function subscription(
  accountId: string,
  status: "active" | "payment_due" | "cancelled",
  currentPeriodEndsAt = "2026-09-12T00:00:00.000Z",
) {
  return {
    accountId,
    status,
    currentPeriodEndsAt,
  };
}

Deno.test("Together grants AI and TURN while hosting grants only AI", async () => {
  const store = new MemoryBillingStore();
  await store.transaction((state) => {
    state.plusSubscriptions.set(
      "plus_1",
      subscription("plus_account", "active"),
    );
    state.sharedHostingSubscriptions.set(
      "hosting_1",
      subscription("hosting_account", "active"),
    );
  });
  const reader = new BillingEntitlementReader(store, () => now);

  assert.deepEqual(await reader.read("plus_account"), {
    ai: true,
    turn: true,
  });
  assert.deepEqual(await reader.read("hosting_account"), {
    ai: true,
    turn: false,
  });
  assert.deepEqual(await reader.read("guest_account"), {
    ai: false,
    turn: false,
  });
});

Deno.test("inactive or expired subscriptions grant no entitlement", async () => {
  const store = new MemoryBillingStore();
  await store.transaction((state) => {
    state.plusSubscriptions.set(
      "plus_due",
      subscription("due_account", "payment_due"),
    );
    state.plusSubscriptions.set(
      "plus_expired",
      subscription(
        "expired_account",
        "active",
        "2026-08-11T00:00:00.000Z",
      ),
    );
  });
  const reader = new BillingEntitlementReader(store, () => now);

  assert.deepEqual(await reader.read("due_account"), {
    ai: false,
    turn: false,
  });
  assert.deepEqual(await reader.read("expired_account"), {
    ai: false,
    turn: false,
  });
});
