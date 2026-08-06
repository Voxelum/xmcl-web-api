import assert from "node:assert/strict";
import { BillingService } from "./billing.ts";
import type { BillingState, BillingStore, Money } from "./ledger.ts";
import { MemoryBillingStore } from "./ledger.ts";
import {
  FakeWaffoWebhookVerifier,
  type WaffoCheckoutProvider,
  WaffoService,
} from "./waffo.ts";

class LeaseTrackingStore implements BillingStore {
  readonly inner = new MemoryBillingStore();
  inTransaction = false;

  async transaction<T>(
    callback: (state: BillingState) => Promise<T> | T,
  ): Promise<T> {
    this.inTransaction = true;
    try {
      return await this.inner.transaction(callback);
    } finally {
      this.inTransaction = false;
    }
  }

  read<T>(callback: (state: BillingState) => T): Promise<T> {
    return this.inner.read(callback);
  }
}

class IdempotentProvider implements WaffoCheckoutProvider {
  readonly createCalls: Array<{ orderId: string; leased: boolean }> = [];
  readonly orders = new Map<
    string,
    { providerOrderId: string; approvalUrl: string }
  >();
  fail = false;
  private blockedCalls = 0;
  private releaseFirst!: () => void;
  private readonly firstBlocked = new Promise<void>((resolve) => {
    this.releaseFirst = resolve;
  });
  private blockedCallStartedResolve!: () => void;
  private blockedCallStarted = Promise.resolve();

  constructor(private readonly store: LeaseTrackingStore) {}

  blockInitialCall() {
    this.blockedCalls += 1;
    this.blockedCallStarted = new Promise<void>((resolve) => {
      this.blockedCallStartedResolve = resolve;
    });
  }

  releaseInitialCall() {
    this.releaseFirst();
  }

  waitForBlockedCall() {
    return this.blockedCallStarted;
  }

  async createCheckout(input: {
    orderId: string;
    amount: Money;
  }) {
    this.createCalls.push({
      orderId: input.orderId,
      leased: this.store.inTransaction,
    });
    if (this.fail) throw new Error("provider unavailable");
    if (this.blockedCalls > 0) {
      this.blockedCalls -= 1;
      this.blockedCallStartedResolve();
      await this.firstBlocked;
    }
    const existing = this.orders.get(input.orderId);
    if (existing) return existing;
    const order = {
      providerOrderId: `cs_${input.orderId}`,
      approvalUrl: `https://checkout.waffo.invalid/${input.orderId}`,
    };
    this.orders.set(input.orderId, order);
    return order;
  }
}

function fixture() {
  let now = Date.parse("2026-07-24T00:00:00.000Z");
  let ids = 0;
  const store = new LeaseTrackingStore();
  const billing = new BillingService(store, {
    currency: "USD",
    rates: [],
    now: () => new Date(now),
    createId: (prefix) => `${prefix}_${++ids}`,
    providerCreationRecoveryMs: 1_000,
  });
  const provider = new IdempotentProvider(store);
  const waffo = new WaffoService(
    billing,
    provider,
    new FakeWaffoWebhookVerifier(),
    { storeId: "STO_xmcl", environment: "test" },
  );
  return {
    billing,
    provider,
    waffo,
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

async function createFailedIntent(
  f: ReturnType<typeof fixture>,
  idempotencyKey: string,
) {
  f.provider.fail = true;
  await assert.rejects(() =>
    f.waffo.createOrder({
      accountId: "account_1",
      idempotencyKey,
      amountMinor: 100,
    })
  );
  f.provider.fail = false;
}

Deno.test("stale Waffo recovery uses the original order identity outside the billing lease", async () => {
  const f = fixture();
  f.provider.blockInitialCall();
  const initial = f.waffo.createOrder({
    accountId: "account_1",
    idempotencyKey: "abandoned",
    amountMinor: 100,
  });
  await f.provider.waitForBlockedCall();
  f.advance(1_001);

  const recovered = await f.waffo.reconcilePendingOrders(
    new Date("2026-07-24T00:00:01.001Z"),
  );
  f.provider.releaseInitialCall();
  const late = await initial;

  assert.deepEqual(recovered.attempted, ["order_1"]);
  assert.deepEqual(recovered.finalized, ["order_1"]);
  assert.equal(f.provider.orders.size, 1);
  assert.equal(f.provider.createCalls.every((call) => !call.leased), true);
  assert.equal(
    f.provider.createCalls.every((call) => call.orderId === "order_1"),
    true,
  );
  assert.equal(late.orderId, "order_1");
  assert.equal((await f.billing.orders("account_1")).length, 1);
});

Deno.test("concurrent client and scheduler Waffo recovery cannot create or credit twice", async () => {
  const f = fixture();
  await createFailedIntent(f, "concurrent");
  f.advance(1_001);
  f.provider.blockInitialCall();
  const scheduled = f.waffo.reconcilePendingOrders(
    new Date("2026-07-24T00:00:01.001Z"),
  );
  await f.provider.waitForBlockedCall();
  const client = await f.waffo.createOrder({
    accountId: "account_1",
    idempotencyKey: "concurrent",
    amountMinor: 100,
  });
  f.provider.releaseInitialCall();
  const result = await scheduled;

  assert.equal(client.orderId, "order_1");
  assert.deepEqual(result.finalized, ["order_1"]);
  assert.equal(f.provider.orders.size, 1);
  assert.equal((await f.billing.balance("account_1")).available.amountMinor, 0);
});

Deno.test("unavailable scheduled Waffo recovery preserves a pending order and cash balance", async () => {
  const f = fixture();
  await createFailedIntent(f, "unavailable");
  f.advance(1_001);
  f.provider.fail = true;

  const result = await f.waffo.reconcilePendingOrders(
    new Date("2026-07-24T00:00:01.001Z"),
  );

  assert.deepEqual(result.attempted, ["order_1"]);
  assert.deepEqual(result.failed, ["order_1"]);
  assert.equal((await f.billing.orders("account_1"))[0]?.status, "pending");
  assert.equal((await f.billing.balance("account_1")).available.amountMinor, 0);
});

Deno.test("scheduled Waffo recovery applies its bound in stable stale-at and order-ID order", async () => {
  const f = fixture();
  await createFailedIntent(f, "first");
  f.advance(1);
  await createFailedIntent(f, "second");
  f.advance(1);
  await createFailedIntent(f, "third");
  f.advance(1_000);

  const result = await f.waffo.reconcilePendingOrders(
    new Date("2026-07-24T00:00:01.002Z"),
    2,
  );

  assert.deepEqual(result.attempted, ["order_1", "order_3"]);
  assert.deepEqual(result.finalized, ["order_1", "order_3"]);
  assert.equal(
    (await f.billing.orders("account_1")).filter((order) => order.approvalUrl)
      .length,
    2,
  );
});
