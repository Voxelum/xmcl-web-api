import { AccountError, randomId } from "./account.ts";
import type {
  BillingOrder,
  BillingResource,
  BillingState,
  BillingStore,
  CashBalance,
  CashRate,
  LedgerEntry,
  Money,
} from "./ledger.ts";

export interface BillingOptions {
  currency: string;
  rates: CashRate[];
  now?: () => Date;
  createId?: (prefix: string) => string;
  providerCreationRecoveryMs?: number;
}

export interface PublicOrder {
  orderId: string;
  cashAmount: Money;
  approvalUrl?: string;
  status: BillingOrder["status"];
  createdAt: string;
  updatedAt: string;
}

export interface AdminOperation {
  operationId: string;
  action: "refund" | "balance_adjust";
  accountId: string;
  amountMinor: number;
  reason: string;
}

export interface AdminOperationCompletion {
  eventType: "admin.operation.completed.v1";
  operationId: string;
  action: AdminOperation["action"];
  status: "completed";
  occurredAt: string;
}

function fail(
  status: 400 | 404 | 409 | 422 | 502,
  code: string,
  message = code,
  details?: unknown,
): never {
  throw new AccountError(status, code, message, details);
}

export function requirePositiveSafeInteger(
  value: unknown,
  code = "invalid_amount",
): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fail(422, code);
  }
  return value as number;
}

export function requireNonNegativeSafeInteger(
  value: unknown,
  code = "invalid_amount",
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(422, code);
  }
  return value as number;
}

export function requireIsoCurrency(value: string): string {
  if (!/^[A-Z]{3}$/.test(value)) fail(422, "invalid_currency");
  return value;
}

export function stableFingerprint(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .filter(([, nested]) => nested !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

function idempotencyScope(
  producerOrAccountId: string,
  operation: string,
  key: string,
) {
  return `${producerOrAccountId}:${operation}:${key}`;
}

function publicOrder(order: BillingOrder): PublicOrder {
  return {
    orderId: order.orderId,
    cashAmount: order.amount,
    ...(order.approvalUrl ? { approvalUrl: order.approvalUrl } : {}),
    status: order.status,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt ?? order.createdAt,
  };
}

function balanceOf(
  state: BillingState,
  accountId: string,
  currency: string,
): CashBalance {
  const stored = state.balances.get(accountId) ?? {
    availableMinor: 0,
    reservedMinor: 0,
  };
  return {
    accountId,
    available: { currency, amountMinor: stored.availableMinor },
    reserved: { currency, amountMinor: stored.reservedMinor },
  };
}

function appendLedger(
  state: BillingState,
  entry: LedgerEntry,
) {
  state.ledger.push(entry);
}

/**
 * The cash/ledger owner. It intentionally depends only on `BillingStore`; a
 * database adapter can provide atomic implementation without changing routes.
 */
export class BillingService {
  private readonly currency: string;
  private readonly rates = new Map<string, CashRate>();
  private readonly now: () => Date;
  private readonly createId: (prefix: string) => string;
  private readonly providerCreationRecoveryMs: number;

  constructor(
    private readonly store: BillingStore,
    options: BillingOptions,
  ) {
    this.currency = requireIsoCurrency(options.currency);
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomId;
    this.providerCreationRecoveryMs = options.providerCreationRecoveryMs ??
      5 * 60 * 1_000;
    if (
      !Number.isSafeInteger(this.providerCreationRecoveryMs) ||
      this.providerCreationRecoveryMs <= 0
    ) {
      throw new Error("Provider creation recovery duration must be positive");
    }
    for (const rate of options.rates) {
      requirePositiveSafeInteger(rate.rateVersion, "invalid_rate");
      requireNonNegativeSafeInteger(rate.amountMinorPerUnit, "invalid_rate");
      if (
        !rate.resource || !rate.unit ||
        !Number.isFinite(Date.parse(rate.effectiveAt))
      ) {
        fail(422, "invalid_rate");
      }

      this.rates.set(this.rateKey(rate.resource, rate.unit, rate.rateVersion), {
        ...rate,
      });
    }
  }

  get settlementCurrency() {
    return this.currency;
  }

  async balance(accountId: string): Promise<CashBalance> {
    return await this.store.read((state) =>
      balanceOf(state, accountId, this.currency)
    );
  }

  listRates(): CashRate[] {
    return [...this.rates.values()].map((rate) => structuredClone(rate));
  }

  rate(
    resource: BillingResource,
    unit: CashRate["unit"],
    rateVersion: number,
  ): CashRate {
    const rate = this.rates.get(this.rateKey(resource, unit, rateVersion));
    if (
      !rate ||
      (rate.retiredAt && Date.parse(rate.retiredAt) <= this.now().getTime())
    ) {
      fail(422, "rate_not_available");
    }
    return structuredClone(rate);
  }

  async ledger(accountId: string): Promise<LedgerEntry[]> {
    return await this.store.read((state) =>
      state.ledger.filter((entry) => entry.accountId === accountId)
    );
  }

  async usage(accountId: string): Promise<unknown[]> {
    return await this.store.read((state) =>
      state.settlements.filter((settlement) =>
        (settlement as { accountId?: string }).accountId === accountId
      )
    );
  }

  async adminLedger(): Promise<LedgerEntry[]> {
    return await this.store.read((state) => state.ledger);
  }

  async createOrder(input: {
    accountId: string;
    idempotencyKey: string;
    amountMinor: number;
    createProviderOrder: (orderId: string, amount: Money) => Promise<{
      providerOrderId: string;
      approvalUrl: string;
    }>;
  }): Promise<PublicOrder> {
    requirePositiveSafeInteger(input.amountMinor);
    if (!input.idempotencyKey) fail(422, "idempotency_key_required");
    const fingerprint = stableFingerprint({
      amountMinor: input.amountMinor,
      currency: this.currency,
    });
    const claim = await this.store.transaction((state) => {
      const scope = idempotencyScope(
        input.accountId,
        "paypal_order",
        input.idempotencyKey,
      );
      const replay = state.idempotencies.get(scope);
      let order: BillingOrder;
      if (replay) {
        if (replay.fingerprint !== fingerprint) {
          fail(409, "idempotency_conflict");
        }
        const replayed = replay.response as PublicOrder;
        const stored = state.orders.get(replayed.orderId);
        if (!stored) fail(409, "order_state_conflict");
        order = stored;
      } else {
        const orderId = this.createId("order");
        const amount = {
          currency: this.currency,
          amountMinor: input.amountMinor,
        };
        order = {
          orderId,
          accountId: input.accountId,
          amount,
          status: "pending",
          createdAt: this.now().toISOString(),
          updatedAt: this.now().toISOString(),
        };
        state.orders.set(order.orderId, order);
        state.idempotencies.set(scope, {
          fingerprint,
          response: publicOrder(order),
        });
      }
      if (order.providerOrderId) {
        return { kind: "complete" as const, order: structuredClone(order) };
      }
      if (
        order.providerCreation &&
        !this.canRecoverProviderCreation(order.providerCreation.startedAt)
      ) {
        return { kind: "pending" as const, order: structuredClone(order) };
      }
      const attemptId = this.createId("paypal_attempt");
      order.providerCreation = {
        attemptId,
        startedAt: this.now().toISOString(),
      };
      order.updatedAt = this.now().toISOString();
      state.idempotencies.set(scope, {
        fingerprint,
        response: publicOrder(order),
      });
      return {
        kind: "provider" as const,
        scope,
        attemptId,
        order: structuredClone(order),
      };
    });
    if (claim.kind !== "provider") return publicOrder(claim.order);
    let provider: { providerOrderId: string; approvalUrl: string };
    try {
      provider = await input.createProviderOrder(
        claim.order.orderId,
        claim.order.amount,
      );
      if (!provider.providerOrderId || !provider.approvalUrl) {
        fail(502, "provider_invalid_response");
      }
    } catch (error) {
      await this.releaseProviderCreation(
        claim.order.orderId,
        claim.scope,
        claim.attemptId,
        fingerprint,
      );
      throw error;
    }
    try {
      return await this.store.transaction((state) => {
        const order = state.orders.get(claim.order.orderId);
        if (!order) fail(409, "order_state_conflict");
        if (order.providerOrderId) return publicOrder(order);
        if (order.providerCreation?.attemptId !== claim.attemptId) {
          return publicOrder(order);
        }
        order.providerOrderId = provider.providerOrderId;
        order.approvalUrl = provider.approvalUrl;
        order.providerCreation = undefined;
        order.updatedAt = this.now().toISOString();
        state.ordersByProviderId.set(provider.providerOrderId, order.orderId);
        const response = publicOrder(order);
        state.idempotencies.set(claim.scope, {
          fingerprint,
          response,
        });
        return response;
      });
    } catch (error) {
      await this.releaseProviderCreation(
        claim.order.orderId,
        claim.scope,
        claim.attemptId,
        fingerprint,
      );
      throw error;
    }
  }

  async orders(accountId: string): Promise<PublicOrder[]> {
    return await this.store.read((state) =>
      [...state.orders.values()]
        .filter((order) => order.accountId === accountId)
        .map(publicOrder)
    );
  }

  async order(accountId: string, orderId: string): Promise<PublicOrder> {
    return publicOrder(await this.orderForAccount(accountId, orderId));
  }

  async orderForAccount(
    accountId: string,
    orderId: string,
  ): Promise<BillingOrder> {
    return await this.store.read((state) => {
      const order = state.orders.get(orderId);
      if (!order || order.accountId !== accountId) fail(404, "order_not_found");
      if (!order.providerOrderId) fail(409, "order_provider_pending");
      return order;
    });
  }

  async recordPaypalCredit(
    providerOrderId: string,
    webhookEventId: string,
    rawBody: string,
  ): Promise<{ duplicate: boolean; order?: PublicOrder }> {
    return await this.store.transaction((state) => {
      if (state.webhookEventIds.has(webhookEventId)) return { duplicate: true };
      const orderId = state.ordersByProviderId.get(providerOrderId);
      if (!orderId) fail(422, "paypal_order_not_found");
      const order = state.orders.get(orderId)!;
      if (order.status === "completed") {
        state.webhookEventIds.add(webhookEventId);
        return { duplicate: true, order: publicOrder(order) };
      }
      const balance = state.balances.get(order.accountId) ?? {
        availableMinor: 0,
        reservedMinor: 0,
      };
      if (
        balance.availableMinor >
          Number.MAX_SAFE_INTEGER - order.amount.amountMinor
      ) {
        fail(422, "unsafe_amount");
      }
      balance.availableMinor += order.amount.amountMinor;
      state.balances.set(order.accountId, balance);
      order.status = "completed";
      appendLedger(state, {
        ledgerEntryId: this.createId("ledger"),
        accountId: order.accountId,
        kind: "paypal_credit",
        amount: order.amount,
        occurredAt: this.now().toISOString(),
        referenceId: webhookEventId,
      });
      state.webhookEventIds.add(webhookEventId);
      state.webhookRawBodies.set(webhookEventId, rawBody);
      return { duplicate: false, order: publicOrder(order) };
    });
  }

  async markWebhookDuplicate(
    webhookEventId: string,
    rawBody: string,
  ): Promise<boolean> {
    return await this.store.transaction((state) => {
      if (state.webhookEventIds.has(webhookEventId)) return true;
      state.webhookEventIds.add(webhookEventId);
      state.webhookRawBodies.set(webhookEventId, rawBody);
      return false;
    });
  }

  async applyAdminOperation(
    operation: AdminOperation,
  ): Promise<AdminOperationCompletion> {
    requirePositiveSafeInteger(operation.amountMinor);
    if (!operation.operationId || !operation.reason) {
      fail(422, "invalid_admin_operation");
    }
    return await this.store.transaction((state) => {
      const existing = state.adminOperations.get(operation.operationId);
      const fingerprint = stableFingerprint(operation);
      if (existing) {
        const stored = existing as {
          fingerprint: string;
          completion: AdminOperationCompletion;
        };
        if (stored.fingerprint !== fingerprint) fail(409, "operation_conflict");
        return stored.completion;
      }
      const balance = state.balances.get(operation.accountId) ?? {
        availableMinor: 0,
        reservedMinor: 0,
      };
      if (operation.action === "refund") {
        if (balance.availableMinor < operation.amountMinor) {
          fail(422, "insufficient_balance");
        }
        balance.availableMinor -= operation.amountMinor;
      } else {
        if (
          balance.availableMinor >
            Number.MAX_SAFE_INTEGER - operation.amountMinor
        ) {
          fail(422, "unsafe_amount");
        }
        balance.availableMinor += operation.amountMinor;
      }
      state.balances.set(operation.accountId, balance);
      appendLedger(state, {
        ledgerEntryId: this.createId("ledger"),
        accountId: operation.accountId,
        kind: operation.action,
        amount: { currency: this.currency, amountMinor: operation.amountMinor },
        occurredAt: this.now().toISOString(),
        referenceId: operation.operationId,
      });
      const completion: AdminOperationCompletion = {
        eventType: "admin.operation.completed.v1",
        operationId: operation.operationId,
        action: operation.action,
        status: "completed",
        occurredAt: this.now().toISOString(),
      };
      state.adminOperations.set(operation.operationId, {
        fingerprint,
        completion,
      });
      return completion;
    });
  }

  private rateKey(resource: BillingResource, unit: string, version: number) {
    return `${resource}:${unit}:${version}`;
  }

  private canRecoverProviderCreation(startedAt: string) {
    const started = Date.parse(startedAt);
    return !Number.isFinite(started) ||
      started <= this.now().getTime() - this.providerCreationRecoveryMs;
  }

  private async releaseProviderCreation(
    orderId: string,
    scope: string,
    attemptId: string,
    fingerprint: string,
  ) {
    await this.store.transaction((state) => {
      const order = state.orders.get(orderId);
      if (!order || order.providerCreation?.attemptId !== attemptId) return;
      order.providerCreation = undefined;
      order.updatedAt = this.now().toISOString();
      state.idempotencies.set(scope, {
        fingerprint,
        response: publicOrder(order),
      });
    });
  }
}
