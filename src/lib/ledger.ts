export type BillingResource =
  | "server_time"
  | "ai_request"
  | "ai_tokens"
  | "storage_retention";
export type MeterUnit = "second" | "request" | "token" | "byte_second";

export interface Money {
  currency: string;
  amountMinor: number;
}

export interface CashBalance {
  accountId: string;
  available: Money;
  reserved: Money;
}

export type LedgerKind =
  | "paypal_credit"
  | "reservation"
  | "reservation_release"
  | "usage_charge"
  | "refund"
  | "balance_adjust";

export interface LedgerEntry {
  ledgerEntryId: string;
  accountId: string;
  kind: LedgerKind;
  amount: Money;
  occurredAt: string;
  referenceId: string;
}

export interface CashRate {
  rateVersion: number;
  resource: BillingResource;
  unit: MeterUnit;
  amountMinorPerUnit: number;
  effectiveAt: string;
  retiredAt?: string;
}

export interface StoredIdempotency {
  fingerprint: string;
  response: unknown;
}

export interface BillingOrder {
  orderId: string;
  accountId: string;
  amount: Money;
  providerOrderId: string;
  approvalUrl: string;
  status: "pending" | "completed" | "failed";
  createdAt: string;
}

export interface StoredAuthorization {
  authorizationId: string;
  accountId: string;
  producerId: string;
  resource: BillingResource;
  sourceId: string;
  expectedQuantity: number;
  unit: MeterUnit;
  settlementIntervalSeconds: number;
  rate: CashRate;
  reservedMinor: number;
  status: "authorized" | "rejected" | "expired" | "released";
  expiresAt: string;
  settledAt?: string;
}

export interface UsageStreamCursor {
  lastSequence?: number;
  lastIntervalEnd?: string;
}

export interface BillingState {
  balances: Map<string, { availableMinor: number; reservedMinor: number }>;
  ledger: LedgerEntry[];
  idempotencies: Map<string, StoredIdempotency>;
  orders: Map<string, BillingOrder>;
  ordersByProviderId: Map<string, string>;
  authorizations: Map<string, StoredAuthorization>;
  settlementsByEventId: Map<string, unknown>;
  settlements: unknown[];
  streams: Map<string, UsageStreamCursor>;
  webhookEventIds: Set<string>;
  webhookRawBodies: Map<string, string>;
  adminOperations: Map<string, unknown>;
}

function emptyState(): BillingState {
  return {
    balances: new Map(),
    ledger: [],
    idempotencies: new Map(),
    orders: new Map(),
    ordersByProviderId: new Map(),
    authorizations: new Map(),
    settlementsByEventId: new Map(),
    settlements: [],
    streams: new Map(),
    webhookEventIds: new Set(),
    webhookRawBodies: new Map(),
    adminOperations: new Map(),
  };
}

function copyState(state: BillingState): BillingState {
  return structuredClone(state);
}

/**
 * A persistence boundary for Billing. Production implementations must apply the
 * callback as one atomic conditional transaction; this memory implementation is
 * deliberately only suitable for direct tests and local composition.
 */
export interface BillingStore {
  transaction<T>(callback: (state: BillingState) => Promise<T> | T): Promise<T>;
  read<T>(callback: (state: BillingState) => T): Promise<T>;
}

export class MemoryBillingStore implements BillingStore {
  private state = emptyState();
  private tail: Promise<void> = Promise.resolve();

  async transaction<T>(
    callback: (state: BillingState) => Promise<T> | T,
  ): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const next = copyState(this.state);
      const result = await callback(next);
      this.state = next;
      return structuredClone(result);
    } finally {
      release();
    }
  }

  async read<T>(callback: (state: BillingState) => T): Promise<T> {
    await this.tail;
    return structuredClone(callback(this.state));
  }
}
