import { AccountError, randomId } from "./account.ts";
import {
  type BillingService,
  requirePositiveSafeInteger,
  stableFingerprint,
} from "./billing.ts";
import type {
  BillingResource,
  BillingState,
  BillingStore,
  CashRate,
  MeterUnit,
  Money,
  StoredAuthorization,
} from "./ledger.ts";

export interface UsageAuthorizationRequest {
  accountId: string;
  resource: BillingResource;
  sourceId: string;
  expectedQuantity: number;
  unit: MeterUnit;
  settlementIntervalSeconds: number;
  rateVersion: number;
  idempotencyKey: string;
  expiresAt: string;
}

export interface UsageAuthorization {
  authorizationId: string;
  accountId: string;
  resource: BillingResource;
  sourceId: string;
  status: StoredAuthorization["status"];
  rateVersion: number;
  expiresAt: string;
  actionOnExhaustion: "stop_required";
}

export interface CanonicalUsageEvent {
  eventType: "usage.recorded.v1";
  eventId: string;
  schemaVersion: 1;
  accountId: string;
  authorizationId: string;
  resource: BillingResource;
  sourceId: string;
  quantity: number;
  unit: MeterUnit;
  rateVersion: number;
  sequence?: number;
  intervalStart: string;
  intervalEnd: string;
  occurredAt: string;
  idempotencyKey: string;
}

export interface UsageSettlementResult {
  settlementId: string;
  usageEventId: string;
  charged: Money;
  ledgerEntryId?: string;
  action: "continue" | "stop_required";
  rateVersion: number;
  status: "settled" | "rejected" | "pending";
}

export interface UsageSettlementOptions {
  now?: () => Date;
  createId?: (prefix: string) => string;
}

const resources: readonly BillingResource[] = [
  "server_time",
  "ai_request",
  "ai_tokens",
  "storage_retention",
];
const units: readonly MeterUnit[] = [
  "second",
  "hour",
  "request",
  "token",
  "byte_second",
];

function reject(
  status: 400 | 403 | 404 | 409 | 422,
  code: string,
  message = code,
  details?: unknown,
): never {
  throw new AccountError(status, code, message, details);
}

function date(value: string, code: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) reject(422, code);
  return parsed;
}

function multiplied(rate: CashRate, quantity: number): number {
  if (rate.amountMinorPerUnit > Number.MAX_SAFE_INTEGER / quantity) {
    reject(422, "unsafe_amount");
  }
  return rate.amountMinorPerUnit * quantity;
}

function authorizationPublic(value: StoredAuthorization): UsageAuthorization {
  return {
    authorizationId: value.authorizationId,
    accountId: value.accountId,
    resource: value.resource,
    sourceId: value.sourceId,
    status: value.status,
    rateVersion: value.rate.rateVersion,
    expiresAt: value.expiresAt,
    actionOnExhaustion: "stop_required",
  };
}

function idempotencyScope(producerId: string, operation: string, key: string) {
  return `${producerId}:${operation}:${key}`;
}

function validateAuthorization(input: UsageAuthorizationRequest) {
  if (!input.accountId || !input.sourceId || !input.idempotencyKey) {
    reject(422, "invalid_usage_authorization");
  }
  if (input.idempotencyKey.length > 255) {
    reject(422, "invalid_usage_authorization");
  }
  if (!resources.includes(input.resource) || !units.includes(input.unit)) {
    reject(422, "invalid_usage_authorization");
  }
  requirePositiveSafeInteger(
    input.expectedQuantity,
    "invalid_usage_authorization",
  );
  requirePositiveSafeInteger(
    input.settlementIntervalSeconds,
    "invalid_usage_authorization",
  );
  requirePositiveSafeInteger(input.rateVersion, "invalid_usage_authorization");
  date(input.expiresAt, "invalid_usage_authorization");
}

function validateEvent(event: CanonicalUsageEvent) {
  if (
    event.eventType !== "usage.recorded.v1" || event.schemaVersion !== 1 ||
    !event.eventId || !event.accountId || !event.authorizationId ||
    !event.sourceId || !event.idempotencyKey ||
    !resources.includes(event.resource) || !units.includes(event.unit)
  ) {
    reject(422, "invalid_usage_event");
  }
  if (event.idempotencyKey.length > 255) reject(422, "invalid_usage_event");
  requirePositiveSafeInteger(event.quantity, "invalid_usage_event");
  requirePositiveSafeInteger(event.rateVersion, "invalid_usage_event");
  if (event.sequence !== undefined) {
    requirePositiveSafeInteger(event.sequence, "invalid_usage_event");
  }
  const start = date(event.intervalStart, "invalid_usage_event");
  const end = date(event.intervalEnd, "invalid_usage_event");
  date(event.occurredAt, "invalid_usage_event");
  if (end <= start) reject(422, "invalid_usage_event");
}

/**
 * D2/D3 cash authorization and canonical usage settlement. The producer ID is
 * supplied by authenticated service middleware, not by the event payload.
 */
export class UsageSettlementService {
  private readonly now: () => Date;
  private readonly createId: (prefix: string) => string;

  constructor(
    private readonly store: BillingStore,
    private readonly billing: BillingService,
    options: UsageSettlementOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomId;
  }

  async authorize(
    producerId: string,
    input: UsageAuthorizationRequest,
  ): Promise<UsageAuthorization> {
    validateAuthorization(input);
    if (
      date(input.expiresAt, "invalid_usage_authorization") <=
        this.now().getTime()
    ) {
      reject(422, "usage_authorization_expired");
    }
    const rate = this.billing.rate(
      input.resource,
      input.unit,
      input.rateVersion,
    );
    const reservationMinor = multiplied(rate, input.expectedQuantity);
    const fingerprint = stableFingerprint(input);
    return await this.store.transaction((state) => {
      const scope = idempotencyScope(
        producerId,
        "usage_authorize",
        input.idempotencyKey,
      );
      const replay = state.idempotencies.get(scope);
      if (replay) {
        if (replay.fingerprint !== fingerprint) {
          reject(409, "idempotency_conflict");
        }
        return replay.response as UsageAuthorization;
      }
      const balance = state.balances.get(input.accountId) ?? {
        availableMinor: 0,
        reservedMinor: 0,
      };
      if (balance.availableMinor < reservationMinor) {
        reject(422, "insufficient_balance");
      }
      balance.availableMinor -= reservationMinor;
      balance.reservedMinor += reservationMinor;
      state.balances.set(input.accountId, balance);
      const authorization: StoredAuthorization = {
        authorizationId: this.createId("authorization"),
        accountId: input.accountId,
        producerId,
        resource: input.resource,
        sourceId: input.sourceId,
        expectedQuantity: input.expectedQuantity,
        unit: input.unit,
        settlementIntervalSeconds: input.settlementIntervalSeconds,
        rate,
        reservedMinor: reservationMinor,
        status: "authorized",
        expiresAt: input.expiresAt,
      };
      state.authorizations.set(authorization.authorizationId, authorization);
      state.ledger.push({
        ledgerEntryId: this.createId("ledger"),
        accountId: input.accountId,
        kind: "reservation",
        amount: {
          currency: this.billing.settlementCurrency,
          amountMinor: reservationMinor,
        },
        occurredAt: this.now().toISOString(),
        referenceId: authorization.authorizationId,
      });
      const response = authorizationPublic(authorization);
      state.idempotencies.set(scope, { fingerprint, response });
      return response;
    });
  }

  async release(
    producerId: string,
    authorizationId: string,
    idempotencyKey: string,
  ): Promise<UsageAuthorization> {
    if (!authorizationId || !idempotencyKey) {
      reject(422, "invalid_usage_release");
    }
    const fingerprint = stableFingerprint({ authorizationId });
    return await this.store.transaction((state) => {
      const scope = idempotencyScope(
        producerId,
        "usage_release",
        idempotencyKey,
      );
      const replay = state.idempotencies.get(scope);
      if (replay) {
        if (replay.fingerprint !== fingerprint) {
          reject(409, "idempotency_conflict");
        }
        return replay.response as UsageAuthorization;
      }
      const authorization = state.authorizations.get(authorizationId);
      if (!authorization) reject(404, "usage_authorization_not_found");
      if (authorization.producerId !== producerId) {
        reject(403, "authorization_forbidden");
      }
      if (authorization.status === "authorized" && !authorization.settledAt) {
        const balance = state.balances.get(authorization.accountId)!;
        balance.reservedMinor -= authorization.reservedMinor;
        balance.availableMinor += authorization.reservedMinor;
        state.ledger.push({
          ledgerEntryId: this.createId("ledger"),
          accountId: authorization.accountId,
          kind: "reservation_release",
          amount: {
            currency: this.billing.settlementCurrency,
            amountMinor: authorization.reservedMinor,
          },
          occurredAt: this.now().toISOString(),
          referenceId: authorization.authorizationId,
        });
        authorization.reservedMinor = 0;
        authorization.status = "released";
      }
      const response = authorizationPublic(authorization);
      state.idempotencies.set(scope, { fingerprint, response });
      return response;
    });
  }

  async settle(
    producerId: string,
    event: CanonicalUsageEvent,
  ): Promise<UsageSettlementResult> {
    validateEvent(event);
    const fingerprint = stableFingerprint(event);
    return await this.store.transaction((state) => {
      const scope = idempotencyScope(
        producerId,
        "usage_settle",
        event.idempotencyKey,
      );
      const replay = state.idempotencies.get(scope);
      if (replay) {
        if (replay.fingerprint !== fingerprint) {
          reject(409, "idempotency_conflict");
        }
        return replay.response as UsageSettlementResult;
      }
      const eventReplay = state.settlementsByEventId.get(event.eventId) as
        | { fingerprint: string; response: UsageSettlementResult }
        | undefined;
      if (eventReplay) {
        if (eventReplay.fingerprint !== fingerprint) {
          reject(409, "usage_event_conflict");
        }
        state.idempotencies.set(scope, {
          fingerprint,
          response: eventReplay.response,
        });
        return eventReplay.response;
      }
      const authorization = state.authorizations.get(event.authorizationId);
      if (!authorization) reject(404, "usage_authorization_not_found");
      if (authorization.producerId !== producerId) {
        reject(403, "authorization_forbidden");
      }
      if (
        authorization.accountId !== event.accountId ||
        authorization.resource !== event.resource ||
        authorization.sourceId !== event.sourceId ||
        authorization.unit !== event.unit ||
        authorization.rate.rateVersion !== event.rateVersion
      ) {
        reject(409, "usage_authorization_binding_mismatch");
      }
      if (authorization.status !== "authorized" || authorization.settledAt) {
        reject(409, "usage_authorization_state_conflict", undefined, {
          authorizationStatus: authorization.status,
        });
      }
      if (
        date(authorization.expiresAt, "invalid_usage_authorization") <=
          this.now().getTime()
      ) {
        authorization.status = "expired";
        reject(409, "usage_authorization_expired");
      }
      const intervalStart = date(event.intervalStart, "invalid_usage_event");
      const intervalEnd = date(event.intervalEnd, "invalid_usage_event");
      if (
        (intervalEnd - intervalStart) / 1000 >
          authorization.settlementIntervalSeconds
      ) {
        reject(422, "usage_interval_exceeds_authorization");
      }
      const streamKey = `${event.accountId}:${event.sourceId}`;
      const cursor = state.streams.get(streamKey);
      if (
        cursor?.lastIntervalEnd &&
        intervalStart < Date.parse(cursor.lastIntervalEnd)
      ) {
        reject(409, "usage_interval_overlap");
      }
      if (event.sequence !== undefined) {
        if (
          cursor?.lastSequence !== undefined &&
          event.sequence <= cursor.lastSequence
        ) {
          reject(409, "usage_out_of_order", undefined, {
            lastSettledSequence: cursor.lastSequence,
          });
        }
      } else if (cursor?.lastSequence !== undefined) {
        reject(409, "usage_sequence_required");
      }
      const chargeMinor = multiplied(authorization.rate, event.quantity);
      const settlementId = this.createId("settlement");
      if (chargeMinor > authorization.reservedMinor) {
        const response: UsageSettlementResult = {
          settlementId,
          usageEventId: event.eventId,
          charged: {
            currency: this.billing.settlementCurrency,
            amountMinor: 0,
          },
          action: "stop_required",
          rateVersion: event.rateVersion,
          status: "rejected",
        };
        state.settlementsByEventId.set(event.eventId, {
          fingerprint,
          response,
        });
        state.idempotencies.set(scope, { fingerprint, response });
        state.settlements.push({ accountId: event.accountId, ...response });
        return response;
      }
      const balance = state.balances.get(event.accountId);
      if (!balance || balance.reservedMinor < authorization.reservedMinor) {
        reject(409, "reservation_state_conflict");
      }
      const unusedReservation = authorization.reservedMinor - chargeMinor;
      balance.reservedMinor -= authorization.reservedMinor;
      balance.availableMinor += unusedReservation;
      const ledgerEntryId = this.createId("ledger");
      state.ledger.push({
        ledgerEntryId,
        accountId: event.accountId,
        kind: "usage_charge",
        amount: {
          currency: this.billing.settlementCurrency,
          amountMinor: chargeMinor,
        },
        occurredAt: this.now().toISOString(),
        referenceId: settlementId,
      });
      if (unusedReservation > 0) {
        state.ledger.push({
          ledgerEntryId: this.createId("ledger"),
          accountId: event.accountId,
          kind: "reservation_release",
          amount: {
            currency: this.billing.settlementCurrency,
            amountMinor: unusedReservation,
          },
          occurredAt: this.now().toISOString(),
          referenceId: authorization.authorizationId,
        });
      }
      authorization.reservedMinor = 0;
      authorization.settledAt = this.now().toISOString();
      state.streams.set(streamKey, {
        lastSequence: event.sequence ?? cursor?.lastSequence,
        lastIntervalEnd: event.intervalEnd,
      });
      const response: UsageSettlementResult = {
        settlementId,
        usageEventId: event.eventId,
        charged: {
          currency: this.billing.settlementCurrency,
          amountMinor: chargeMinor,
        },
        ledgerEntryId,
        action: "continue",
        rateVersion: event.rateVersion,
        status: "settled",
      };
      state.settlementsByEventId.set(event.eventId, { fingerprint, response });
      state.idempotencies.set(scope, { fingerprint, response });
      state.settlements.push({ accountId: event.accountId, ...response });
      return response;
    });
  }
}
