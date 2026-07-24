import assert from "node:assert/strict";
import type { Db, MongoCollection } from "../db.ts";
import { BillingService } from "./billing.ts";
import { BILLING_STATE_COLLECTION, MongoBillingStore } from "./ledger.ts";

function valueAt(record: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (value, part) =>
      value && typeof value === "object"
        ? (value as Record<string, unknown>)[part]
        : undefined,
    record,
  );
}

function matchesValue(value: unknown, expected: unknown): boolean {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    return value === expected;
  }
  const query = expected as Record<string, unknown>;
  if ("$exists" in query) return (value !== undefined) === query.$exists;
  if ("$lte" in query) {
    return value instanceof Date && query.$lte instanceof Date &&
      value.getTime() <= query.$lte.getTime();
  }
  return value === expected;
}

function matches(
  document: Record<string, unknown>,
  filter: Record<string, unknown>,
): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") {
      return (expected as Record<string, unknown>[]).some((item) =>
        matches(document, item)
      );
    }
    return matchesValue(valueAt(document, key), expected);
  });
}

function setValue(
  record: Record<string, unknown>,
  path: string,
  value: unknown,
) {
  const parts = path.split(".");
  let target = record;
  for (const part of parts.slice(0, -1)) {
    target[part] ??= {};
    target = target[part] as Record<string, unknown>;
  }
  target[parts.at(-1)!] = structuredClone(value);
}

function unsetValue(record: Record<string, unknown>, path: string) {
  const parts = path.split(".");
  let target: Record<string, unknown> | undefined = record;
  for (const part of parts.slice(0, -1)) {
    const next: unknown = target?.[part];
    target = next && typeof next === "object"
      ? next as Record<string, unknown>
      : undefined;
  }
  if (target) delete target[parts.at(-1)!];
}

class FakeCollection implements MongoCollection {
  readonly documents = new Map<string, Record<string, unknown>>();

  async findOne(filter: Record<string, unknown>) {
    return [...this.documents.values()].find((document) =>
        matches(document, filter)
      )
      ? structuredClone(
        [...this.documents.values()].find((document) =>
          matches(document, filter)
        ),
      )
      : null;
  }

  async findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { returnDocument?: "before" | "after" },
  ) {
    const document = [...this.documents.values()].find((item) =>
      matches(item, filter)
    );
    if (!document) return null;
    const before = structuredClone(document);
    this.apply(document, update, false);
    return structuredClone(
      options?.returnDocument === "before" ? before : document,
    );
  }

  async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { upsert?: boolean },
  ) {
    let document = [...this.documents.values()].find((item) =>
      matches(item, filter)
    );
    const inserted = !document;
    if (!document && options?.upsert) {
      document = { _id: filter._id };
      this.documents.set(String(document._id), document);
    }
    if (!document) return { matchedCount: 0, modifiedCount: 0 };
    this.apply(document, update, inserted);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async replaceOne() {
    throw new Error("replaceOne is not used by this test");
  }

  async deleteOne() {
    throw new Error("deleteOne is not used by this test");
  }

  private apply(
    document: Record<string, unknown>,
    update: Record<string, unknown>,
    inserted: boolean,
  ) {
    if (inserted && update.$setOnInsert) {
      for (
        const [key, value] of Object.entries(
          update.$setOnInsert as Record<string, unknown>,
        )
      ) setValue(document, key, value);
    }
    if (update.$set) {
      for (
        const [key, value] of Object.entries(
          update.$set as Record<string, unknown>,
        )
      ) setValue(document, key, value);
    }
    if (update.$inc) {
      for (
        const [key, value] of Object.entries(
          update.$inc as Record<string, number>,
        )
      ) setValue(document, key, Number(valueAt(document, key) ?? 0) + value);
    }
    if (update.$unset) {
      for (const key of Object.keys(update.$unset as Record<string, unknown>)) {
        unsetValue(document, key);
      }
    }
  }
}

class FakeDb implements Db {
  readonly collectionValue = new FakeCollection();
  collection(name: string) {
    assert.equal(name, BILLING_STATE_COLLECTION);
    return this.collectionValue;
  }
}

Deno.test("MongoBillingStore persists committed billing state across store instances", async () => {
  const db = new FakeDb();
  const now = new Date("2026-07-24T00:00:00.000Z");
  const first = new MongoBillingStore(db, { now: () => now });

  await first.transaction((state) => {
    state.balances.set("account_1", {
      availableMinor: 120,
      reservedMinor: 30,
    });
    state.ledger.push({
      ledgerEntryId: "ledger_1",
      accountId: "account_1",
      kind: "paypal_credit",
      amount: { currency: "USD", amountMinor: 150 },
      occurredAt: now.toISOString(),
      referenceId: "order_1",
    });
  });

  const second = new MongoBillingStore(db, { now: () => now });
  const snapshot = await second.read((state) => ({
    balance: state.balances.get("account_1"),
    ledger: state.ledger,
  }));

  assert.deepEqual(snapshot.balance, {
    availableMinor: 120,
    reservedMinor: 30,
  });
  assert.deepEqual(snapshot.ledger, [{
    ledgerEntryId: "ledger_1",
    accountId: "account_1",
    kind: "paypal_credit",
    amount: { currency: "USD", amountMinor: 150 },
    occurredAt: now.toISOString(),
    referenceId: "order_1",
  }]);
});

Deno.test("MongoBillingStore rejects a commit if its lease token no longer owns the state", async () => {
  const db = new FakeDb();
  const now = new Date("2026-07-24T00:00:00.000Z");
  const store = new MongoBillingStore(db, { now: () => now });

  await assert.rejects(
    () =>
      store.transaction(async (state) => {
        state.balances.set("account_1", {
          availableMinor: 1,
          reservedMinor: 0,
        });
        await db.collectionValue.updateOne(
          { _id: "billing-state-v1" },
          { $set: { "lease.token": "other-owner" } },
        );
      }),
    /lease was lost/,
  );
  const snapshot = await store.read((state) => state.balances.get("account_1"));
  assert.equal(snapshot, undefined);
});

Deno.test("PayPal provider creation runs after the Mongo billing lease is released", async () => {
  const db = new FakeDb();
  const now = new Date("2026-07-24T00:00:00.000Z");
  const billing = new BillingService(new MongoBillingStore(db, { now: () => now }), {
    currency: "USD",
    rates: [],
    now: () => now,
    createId: (prefix) => `${prefix}_1`,
  });
  let providerCalled = false;

  const order = await billing.createOrder({
    accountId: "account_1",
    idempotencyKey: "paypal_order_1",
    amountMinor: 100,
    createProviderOrder: async (orderId) => {
      providerCalled = true;
      const document = db.collectionValue.documents.get("billing-state-v1")!;
      assert.equal(valueAt(document, "lease"), undefined);
      return {
        providerOrderId: `paypal_${orderId}`,
        approvalUrl: `https://paypal.invalid/checkout/${orderId}`,
      };
    },
  });

  assert.equal(providerCalled, true);
  assert.equal(order.approvalUrl, "https://paypal.invalid/checkout/order_1");
});
