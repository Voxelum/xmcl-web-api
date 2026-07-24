import { randomId } from "./account.ts";
import type { Db, MongoCollection } from "../db.ts";

export type BillingResource =
  | "server_time"
  | "ai_request"
  | "ai_tokens"
  | "storage_retention";
export type MeterUnit =
  | "second"
  | "hour"
  | "request"
  | "token"
  | "byte_second";

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
  | "shared_base_fee"
  | "shared_runtime_fee"
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
  providerOrderId?: string;
  approvalUrl?: string;
  providerCreation?: {
    attemptId: string;
    startedAt: string;
  };
  status: "pending" | "completed" | "failed";
  createdAt: string;
  updatedAt?: string;
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
  sharedHostingSubscriptions: Map<string, unknown>;
  sharedRuntimeWatermarks: Map<
    string,
    { assignmentId: string; startedAt: string; settledHours: number }
  >;
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
    sharedHostingSubscriptions: new Map(),
    sharedRuntimeWatermarks: new Map(),
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

export const BILLING_STATE_COLLECTION = "xmcl_billing_state";

interface SerializedBillingState {
  balances: [string, { availableMinor: number; reservedMinor: number }][];
  ledger: LedgerEntry[];
  idempotencies: [string, StoredIdempotency][];
  orders: [string, BillingOrder][];
  ordersByProviderId: [string, string][];
  authorizations: [string, StoredAuthorization][];
  settlementsByEventId: [string, unknown][];
  settlements: unknown[];
  streams: [string, UsageStreamCursor][];
  webhookEventIds: string[];
  webhookRawBodies: [string, string][];
  adminOperations: [string, unknown][];
  sharedHostingSubscriptions: [string, unknown][];
  sharedRuntimeWatermarks: [
    string,
    { assignmentId: string; startedAt: string; settledHours: number },
  ][];
}

interface BillingStateDocument {
  _id: string;
  version: number;
  state: SerializedBillingState;
  lease?: { token: string; expiresAt: Date };
}

export interface MongoBillingStoreOptions {
  collectionName?: string;
  now?: () => Date;
  lockLeaseMs?: number;
  lockWaitMs?: number;
  createLockToken?: () => string;
}

function serializeState(state: BillingState): SerializedBillingState {
  return {
    balances: [...state.balances.entries()],
    ledger: structuredClone(state.ledger),
    idempotencies: [...state.idempotencies.entries()],
    orders: [...state.orders.entries()],
    ordersByProviderId: [...state.ordersByProviderId.entries()],
    authorizations: [...state.authorizations.entries()],
    settlementsByEventId: [...state.settlementsByEventId.entries()],
    settlements: structuredClone(state.settlements),
    streams: [...state.streams.entries()],
    webhookEventIds: [...state.webhookEventIds],
    webhookRawBodies: [...state.webhookRawBodies.entries()],
    adminOperations: [...state.adminOperations.entries()],
    sharedHostingSubscriptions: [...state.sharedHostingSubscriptions.entries()],
    sharedRuntimeWatermarks: [...state.sharedRuntimeWatermarks.entries()],
  };
}

function requireArray<T>(value: unknown, field: string): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`Malformed persisted billing state: ${field}`);
  }
  return value as T[];
}

function deserializeState(value: unknown): BillingState {
  if (!value || typeof value !== "object") {
    throw new Error("Malformed persisted billing state");
  }
  const state = value as Partial<SerializedBillingState>;
  return {
    balances: new Map(requireArray(state.balances, "balances")),
    ledger: structuredClone(requireArray<LedgerEntry>(state.ledger, "ledger")),
    idempotencies: new Map(requireArray(state.idempotencies, "idempotencies")),
    orders: new Map(requireArray(state.orders, "orders")),
    ordersByProviderId: new Map(
      requireArray(state.ordersByProviderId, "ordersByProviderId"),
    ),
    authorizations: new Map(
      requireArray(state.authorizations, "authorizations"),
    ),
    settlementsByEventId: new Map(
      requireArray(state.settlementsByEventId, "settlementsByEventId"),
    ),
    settlements: structuredClone(
      requireArray<unknown>(state.settlements, "settlements"),
    ),
    streams: new Map(requireArray(state.streams, "streams")),
    webhookEventIds: new Set(
      requireArray<string>(state.webhookEventIds, "webhookEventIds"),
    ),
    webhookRawBodies: new Map(
      requireArray(state.webhookRawBodies, "webhookRawBodies"),
    ),
    adminOperations: new Map(
      requireArray(state.adminOperations, "adminOperations"),
    ),
    sharedHostingSubscriptions: new Map(
      requireArray(
        state.sharedHostingSubscriptions ?? [],
        "sharedHostingSubscriptions",
      ),
    ),
    sharedRuntimeWatermarks: new Map(
      requireArray(
        state.sharedRuntimeWatermarks ?? [],
        "sharedRuntimeWatermarks",
      ),
    ),
  };
}

function documentFrom(value: unknown): BillingStateDocument | undefined {
  const document = value && typeof value === "object" && "value" in value
    ? (value as { value?: unknown }).value
    : value;
  if (
    !document || typeof document !== "object" ||
    typeof (document as { _id?: unknown })._id !== "string" ||
    typeof (document as { version?: unknown }).version !== "number"
  ) {
    return undefined;
  }
  return document as BillingStateDocument;
}

function didMatch(result: unknown): boolean {
  return typeof result === "object" && result !== null &&
    ("matchedCount" in result || "modifiedCount" in result) &&
    (Number((result as { matchedCount?: unknown }).matchedCount) > 0 ||
      Number((result as { modifiedCount?: unknown }).modifiedCount) > 0);
}

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Cosmos DB's Mongo API cannot be assumed to provide multi-document
 * transactions across every account configuration. The billing aggregate is
 * therefore committed as one versioned document. A lease serializes callbacks
 * that mutate the generic BillingState, including its idempotency registry.
 *
 * Provider I/O must never be performed from a transaction callback. Callers
 * persist an idempotent intent, release the lease, invoke the provider with
 * that intent's stable request ID, then conditionally reconcile the response.
 */
export class MongoBillingStore implements BillingStore {
  private readonly collection: MongoCollection;
  private readonly now: () => Date;
  private readonly lockLeaseMs: number;
  private readonly lockWaitMs: number;
  private readonly createLockToken: () => string;

  constructor(
    db: Db,
    options: MongoBillingStoreOptions = {},
  ) {
    this.collection = db.collection(
      options.collectionName ?? BILLING_STATE_COLLECTION,
    );
    this.now = options.now ?? (() => new Date());
    this.lockLeaseMs = options.lockLeaseMs ?? 120_000;
    this.lockWaitMs = options.lockWaitMs ?? 10_000;
    this.createLockToken = options.createLockToken ??
      (() => randomId("bill_lock"));
    if (this.lockLeaseMs <= 0 || this.lockWaitMs <= 0) {
      throw new Error("Billing lock durations must be positive");
    }
  }

  async transaction<T>(
    callback: (state: BillingState) => Promise<T> | T,
  ): Promise<T> {
    const locked = await this.acquire();
    try {
      const next = deserializeState(locked.document.state);
      const result = await callback(next);
      const committed = await this.collection.updateOne(
        {
          _id: locked.document._id,
          version: locked.document.version,
          "lease.token": locked.token,
        },
        {
          $set: { state: serializeState(next) },
          $inc: { version: 1 },
          $unset: { lease: "" },
        },
      );
      if (!didMatch(committed)) {
        throw new Error(
          "Billing transaction lease was lost before its state could be committed",
        );
      }
      return structuredClone(result);
    } catch (error) {
      await this.release(locked.token);
      throw error;
    }
  }

  async read<T>(callback: (state: BillingState) => T): Promise<T> {
    await this.ensureStateDocument();
    const document = documentFrom(
      await this.collection.findOne({ _id: "billing-state-v1" }),
    );
    if (!document) throw new Error("Billing state document is unavailable");
    return structuredClone(callback(deserializeState(document.state)));
  }

  private async ensureStateDocument() {
    await this.collection.updateOne(
      { _id: "billing-state-v1" },
      {
        $setOnInsert: {
          _id: "billing-state-v1",
          version: 0,
          state: serializeState(emptyState()),
        },
      },
      { upsert: true },
    );
  }

  private async acquire(): Promise<{
    token: string;
    document: BillingStateDocument;
  }> {
    await this.ensureStateDocument();
    const deadline = this.now().getTime() + this.lockWaitMs;
    while (this.now().getTime() < deadline) {
      const token = this.createLockToken();
      const now = this.now();
      const document = documentFrom(
        await this.collection.findOneAndUpdate(
          {
            _id: "billing-state-v1",
            $or: [
              { lease: { $exists: false } },
              { "lease.expiresAt": { $lte: now } },
            ],
          },
          {
            $set: {
              lease: {
                token,
                expiresAt: new Date(now.getTime() + this.lockLeaseMs),
              },
            },
          },
          { returnDocument: "after" },
        ),
      );
      if (document?.lease?.token === token) {
        return { token, document };
      }
      await sleep(25);
    }
    throw new Error("Timed out waiting for the billing state lease");
  }

  private async release(token: string) {
    await this.collection.updateOne(
      { _id: "billing-state-v1", "lease.token": token },
      { $unset: { lease: "" } },
    );
  }
}
