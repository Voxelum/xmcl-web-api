import { AccountError, randomId } from "./account.ts";
import { requirePositiveSafeInteger, stableFingerprint } from "./billing.ts";
import type {
  BillingResource,
  BillingState,
  BillingStore,
  CashRate,
  LedgerEntry,
  MeterUnit,
} from "./ledger.ts";
import {
  enabledSharedHostingRegions,
  requireSharedHostingRegion,
  type SharedHostingRegion,
} from "./sharedHostingRegions.ts";

const SHARED_HOSTING_RATE_RESOURCE: BillingResource = "server_time";
const SHARED_HOSTING_RATE_UNIT: MeterUnit = "hour";

export interface SharedHostingPlan {
  planId: "shared-small" | "shared-medium" | "shared-large";
  displayName: string;
  memoryMiB: number;
  sharedCpu: number;
  burstCpu: number;
  persistentStorageGiB: number;
  monthlyBaseMinor: number;
  hourlyRateVersion: number;
  hourlyAmountMinor: number;
  currency?: string;
}

export type PublicSharedHostingPlan = Omit<SharedHostingPlan, "burstCpu">;

export const SHARED_HOSTING_PLANS: readonly SharedHostingPlan[] = [
  {
    planId: "shared-small",
    displayName: "Together Camp",
    memoryMiB: 4 * 1024,
    sharedCpu: 2,
    burstCpu: 4,
    persistentStorageGiB: 32,
    monthlyBaseMinor: 400,
    hourlyRateVersion: 101,
    hourlyAmountMinor: 6,
  },
  {
    planId: "shared-medium",
    displayName: "Together Lodge",
    memoryMiB: 6 * 1024,
    sharedCpu: 3,
    burstCpu: 6,
    persistentStorageGiB: 48,
    monthlyBaseMinor: 600,
    hourlyRateVersion: 102,
    hourlyAmountMinor: 9,
  },
  {
    planId: "shared-large",
    displayName: "Together Village",
    memoryMiB: 8 * 1024,
    sharedCpu: 4,
    burstCpu: 8,
    persistentStorageGiB: 64,
    monthlyBaseMinor: 800,
    hourlyRateVersion: 103,
    hourlyAmountMinor: 12,
  },
] as const;

export const SHARED_HOSTING_RATES: readonly CashRate[] = SHARED_HOSTING_PLANS
  .map((plan) => ({
    rateVersion: plan.hourlyRateVersion,
    resource: SHARED_HOSTING_RATE_RESOURCE,
    unit: SHARED_HOSTING_RATE_UNIT,
    amountMinorPerUnit: plan.hourlyAmountMinor,
    effectiveAt: "2026-07-24T00:00:00.000Z",
  }));

export type SharedHostingSubscriptionStatus =
  | "active"
  | "payment_due"
  | "cancelled";

export interface SharedHostingSubscription {
  subscriptionId: string;
  accountId: string;
  planId: SharedHostingPlan["planId"];
  regionId?: string;
  status: SharedHostingSubscriptionStatus;
  currentPeriodStartedAt: string;
  currentPeriodEndsAt: string;
  createdAt: string;
  updatedAt: string;
  cancelAtPeriodEnd?: true;
  cancelledAt?: string;
  retentionEndsAt?: string;
  pendingRuntimeCharge?: {
    amountMinor: number;
    serviceId: string;
    assignmentId: string;
    startedAt: string;
    fromHour: number;
    toHour: number;
    occurredAt: string;
  };
}

export interface PublicSharedHostingSubscription
  extends SharedHostingSubscription {
  plan: PublicSharedHostingPlan;
}

export interface SharedHostingRuntimeRate {
  resource: "server_time";
  unit: "hour";
  rateVersion: number;
  amountMinorPerHour: number;
}

export interface SharedHostingServiceOptions {
  currency?: string;
  enabledRegionIds?: readonly string[];
  now?: () => Date;
  createId?: (prefix: string) => string;
}

export interface SharedHostingRuntimeCharge {
  status: "settled" | "payment_due";
  chargedHours: number;
  amountMinor: number;
  rateVersion: number;
}

export interface SharedHostingRuntimeSettlementInput {
  accountId: string;
  serviceId: string;
  subscriptionId: string;
  planId: SharedHostingPlan["planId"];
  assignmentId: string;
  startedAt: string;
  settledHours: number;
  settledAt: string;
}

export const SHARED_HOSTING_STORAGE_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1_000;
export const SHARED_HOSTING_CANCELLATION_RETENTION_MS = 30 * 24 * 60 * 60 *
  1_000;

function plan(planId: string): SharedHostingPlan {
  const value = SHARED_HOSTING_PLANS.find((item) => item.planId === planId);
  if (!value) throw new AccountError(422, "shared_plan_not_available");
  return value;
}

function publicPlan(
  value: SharedHostingPlan,
  currency: string,
): PublicSharedHostingPlan {
  return {
    planId: value.planId,
    displayName: value.displayName,
    memoryMiB: value.memoryMiB,
    sharedCpu: value.sharedCpu,
    persistentStorageGiB: value.persistentStorageGiB,
    monthlyBaseMinor: value.monthlyBaseMinor,
    hourlyRateVersion: value.hourlyRateVersion,
    hourlyAmountMinor: value.hourlyAmountMinor,
    currency,
  };
}

function publicSubscription(
  subscription: SharedHostingSubscription,
  currency?: string,
): PublicSharedHostingSubscription {
  return {
    ...structuredClone(subscription),
    plan: publicPlan(plan(subscription.planId), currency ?? "USD"),
  };
}

function addCalendarMonth(value: Date): Date {
  const next = new Date(value);
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const lastDay = new Date(
    Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
  ).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return next;
}

function idempotencyScope(accountId: string, operation: string, key: string) {
  return `${accountId}:${operation}:${key}`;
}

/**
 * Owns the shared-hosting commercial catalog. It only reserves/charges cash
 * and records subscription state; global slot scheduling and object-storage
 * synchronization are separate runtime concerns.
 */
export class SharedHostingService {
  private readonly currency: string;
  private readonly now: () => Date;
  private readonly createId: (prefix: string) => string;
  private readonly enabledRegions: readonly SharedHostingRegion[];

  constructor(
    private readonly store: BillingStore,
    options: SharedHostingServiceOptions = {},
  ) {
    this.currency = options.currency ?? "USD";
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomId;
    this.enabledRegions = enabledSharedHostingRegions(
      options.enabledRegionIds ?? ["sgp"],
    );
  }

  listPlans() {
    return SHARED_HOSTING_PLANS.map((item) => publicPlan(item, this.currency));
  }

  listRegions() {
    return structuredClone(this.enabledRegions);
  }

  runtimeRate(planId: string): SharedHostingRuntimeRate {
    const selected = plan(planId);
    return {
      resource: "server_time",
      unit: "hour",
      rateVersion: selected.hourlyRateVersion,
      amountMinorPerHour: selected.hourlyAmountMinor,
    };
  }

  async subscriptions(accountId: string) {
    return await this.store.read((state) =>
      [...state.sharedHostingSubscriptions.values()]
        .map((item) => item as SharedHostingSubscription)
        .filter((item) => item.accountId === accountId)
        .map((item) => publicSubscription(item, this.currency))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    );
  }

  async activeSubscription(accountId: string, subscriptionId: string) {
    return await this.store.read((state) => {
      const subscription = state.sharedHostingSubscriptions.get(
        subscriptionId,
      ) as SharedHostingSubscription | undefined;
      if (!subscription || subscription.accountId !== accountId) {
        throw new AccountError(404, "shared_subscription_not_found");
      }

      if (subscription.status !== "active") {
        throw new AccountError(409, "shared_subscription_not_active");
      }
      return publicSubscription(subscription, this.currency);
    });
  }

  async cancellationRetentions(subscriptionIds: readonly string[]) {
    const wanted = new Set(subscriptionIds);
    return await this.store.read((state) =>
      [...state.sharedHostingSubscriptions.values()]
        .map((item) => item as SharedHostingSubscription)
        .filter((item) =>
          wanted.has(item.subscriptionId) &&
          item.status === "cancelled" &&
          item.cancelledAt !== undefined &&
          item.retentionEndsAt !== undefined
        )
        .map((item) => ({
          subscriptionId: item.subscriptionId,
          retentionStartedAt: item.cancelledAt!,
          retentionEndsAt: item.retentionEndsAt!,
        }))
    );
  }

  async recoverPaymentDue(
    accountId: string,
    at = this.now(),
  ): Promise<string[]> {
    return await this.store.transaction((state) => {
      const recovered: string[] = [];
      for (
        const subscription of [...state.sharedHostingSubscriptions.values()]
          .map((item) => item as SharedHostingSubscription)
          .filter((item) =>
            item.accountId === accountId && item.status === "payment_due"
          )
      ) {
        const selected = plan(subscription.planId);
        const balance = state.balances.get(accountId) ?? {
          availableMinor: 0,
          reservedMinor: 0,
        };
        const periodExpired =
          Date.parse(subscription.currentPeriodEndsAt) <= at.getTime();
        if (periodExpired && subscription.cancelAtPeriodEnd) {
          const pending = subscription.pendingRuntimeCharge;
          if (pending && balance.availableMinor < pending.amountMinor) {
            continue;
          }
          if (pending) {
            this.chargePendingRuntime(state, subscription, pending, at);
          }
          this.markCancelled(subscription, at);
          state.sharedHostingSubscriptions.set(
            subscription.subscriptionId,
            subscription,
          );
          continue;
        }
        const pending = subscription.pendingRuntimeCharge;
        const totalDue = (periodExpired ? selected.monthlyBaseMinor : 0) +
          (pending?.amountMinor ?? 0);
        if (totalDue > 0 && balance.availableMinor < totalDue) continue;
        if (periodExpired) {
          subscription.currentPeriodStartedAt =
            subscription.currentPeriodEndsAt;
          subscription.currentPeriodEndsAt = addCalendarMonth(
            new Date(subscription.currentPeriodEndsAt),
          ).toISOString();
          this.chargeBaseFee(
            state,
            subscription,
            selected,
            `subscription:${subscription.subscriptionId}:${subscription.currentPeriodStartedAt}`,
          );
        }
        if (pending) {
          this.chargePendingRuntime(state, subscription, pending, at);
        } else if (
          !periodExpired && balance.availableMinor < selected.hourlyAmountMinor
        ) {
          continue;
        }
        subscription.status = "active";
        subscription.updatedAt = at.toISOString();
        state.sharedHostingSubscriptions.set(
          subscription.subscriptionId,
          subscription,
        );
        recovered.push(subscription.subscriptionId);
      }
      return recovered;
    });
  }

  private chargePendingRuntime(
    state: BillingState,
    subscription: SharedHostingSubscription,
    pending: NonNullable<SharedHostingSubscription["pendingRuntimeCharge"]>,
    at: Date,
  ) {
    const balance = state.balances.get(subscription.accountId) ?? {
      availableMinor: 0,
      reservedMinor: 0,
    };
    balance.availableMinor -= pending.amountMinor;
    state.balances.set(subscription.accountId, balance);
    state.ledger.push({
      ledgerEntryId: this.createId("ledger"),
      accountId: subscription.accountId,
      kind: "shared_runtime_fee",
      amount: {
        currency: this.currency,
        amountMinor: pending.amountMinor,
      },
      occurredAt: at.toISOString(),
      referenceId:
        `shared-runtime-arrears:${pending.serviceId}:${pending.assignmentId}:${pending.fromHour}-${pending.toHour}`,
    });
    const watermark = state.sharedRuntimeWatermarks.get(pending.serviceId);
    state.sharedRuntimeWatermarks.set(pending.serviceId, {
      assignmentId: pending.assignmentId,
      startedAt: pending.startedAt,
      settledHours: watermark?.assignmentId === pending.assignmentId
        ? Math.max(watermark.settledHours, pending.toHour)
        : pending.toHour,
    });
    delete subscription.pendingRuntimeCharge;
  }

  private markCancelled(
    subscription: SharedHostingSubscription,
    processedAt: Date,
  ) {
    const effectiveAt = subscription.currentPeriodEndsAt;
    subscription.status = "cancelled";
    subscription.cancelledAt = effectiveAt;
    subscription.retentionEndsAt = new Date(
      Date.parse(effectiveAt) + SHARED_HOSTING_CANCELLATION_RETENTION_MS,
    ).toISOString();
    subscription.updatedAt = processedAt.toISOString();
  }

  async adminSubscriptions() {
    return await this.store.read((state) =>
      [...state.sharedHostingSubscriptions.values()]
        .map((item) => item as SharedHostingSubscription)
        .map((item) => publicSubscription(item, this.currency))
        .sort((left, right) =>
          left.accountId.localeCompare(right.accountId) ||
          left.createdAt.localeCompare(right.createdAt)
        )
    );
  }

  /**
   * Charges whole runtime hours using the immutable plan rate. The first
   * successful start settles one hour; later calls settle only newly elapsed
   * whole hours. The deterministic idempotency scope makes retries safe if the
   * scheduler loses the response after the ledger commit.
   */
  async settleRuntime(
    input: SharedHostingRuntimeSettlementInput,
  ): Promise<SharedHostingRuntimeCharge> {
    const selected = plan(input.planId);
    const requestedStartedAt = Date.parse(input.startedAt);
    const settledAt = Date.parse(input.settledAt);
    if (
      !Number.isFinite(requestedStartedAt) || !Number.isFinite(settledAt) ||
      !Number.isSafeInteger(input.settledHours) || input.settledHours < 0 ||
      !input.accountId || !input.serviceId || !input.subscriptionId ||
      !input.assignmentId
    ) {
      throw new AccountError(422, "invalid_shared_runtime");
    }
    return await this.store.transaction((state) => {
      const watermark = state.sharedRuntimeWatermarks.get(input.serviceId);
      if (
        watermark && watermark.assignmentId === input.assignmentId &&
        watermark.startedAt !== input.startedAt
      ) {
        throw new AccountError(409, "shared_runtime_conflict");
      }
      const startedAt = watermark?.assignmentId === input.assignmentId
        ? Date.parse(watermark.startedAt)
        : requestedStartedAt;
      const settledHours = watermark?.assignmentId === input.assignmentId
        ? watermark.settledHours
        : input.settledHours;
      if (settledAt < startedAt) {
        throw new AccountError(422, "invalid_shared_runtime");
      }
      const elapsedHours = Math.max(
        1,
        Math.ceil((settledAt - startedAt) / (60 * 60 * 1_000)),
      );
      const hoursToCharge = Math.max(0, elapsedHours - settledHours);
      const amountMinor = hoursToCharge * selected.hourlyAmountMinor;
      if (!Number.isSafeInteger(amountMinor)) {
        throw new AccountError(422, "unsafe_amount");
      }
      const fingerprint = stableFingerprint({
        accountId: input.accountId,
        serviceId: input.serviceId,
        planId: selected.planId,
        assignmentId: input.assignmentId,
        startedAt: input.startedAt,
        elapsedHours,
      });
      const scope = idempotencyScope(
        input.accountId,
        "shared_runtime",
        `${input.serviceId}:${input.assignmentId}:${elapsedHours}`,
      );
      const replay = state.idempotencies.get(scope);
      if (replay) {
        if (replay.fingerprint !== fingerprint) {
          throw new AccountError(409, "idempotency_conflict");
        }
        return replay.response as SharedHostingRuntimeCharge;
      }
      const subscription = state.sharedHostingSubscriptions.get(
        input.subscriptionId,
      ) as SharedHostingSubscription | undefined;
      if (
        !subscription || subscription.accountId !== input.accountId ||
        subscription.planId !== selected.planId
      ) {
        throw new AccountError(404, "shared_subscription_not_found");
      }
      if (subscription.status !== "active") {
        const response: SharedHostingRuntimeCharge = {
          status: "payment_due",
          chargedHours: settledHours,
          amountMinor: 0,
          rateVersion: selected.hourlyRateVersion,
        };
        state.idempotencies.set(scope, { fingerprint, response });
        return response;
      }
      const balance = state.balances.get(input.accountId) ?? {
        availableMinor: 0,
        reservedMinor: 0,
      };
      if (balance.availableMinor < amountMinor) {
        subscription.status = "payment_due";
        subscription.updatedAt = input.settledAt;
        subscription.pendingRuntimeCharge = {
          amountMinor,
          serviceId: input.serviceId,
          assignmentId: input.assignmentId,
          startedAt: input.startedAt,
          fromHour: settledHours + 1,
          toHour: elapsedHours,
          occurredAt: input.settledAt,
        };
        state.sharedHostingSubscriptions.set(
          subscription.subscriptionId,
          subscription,
        );
        const response: SharedHostingRuntimeCharge = {
          status: "payment_due",
          chargedHours: settledHours,
          amountMinor: 0,
          rateVersion: selected.hourlyRateVersion,
        };
        state.idempotencies.set(scope, { fingerprint, response });
        return response;
      }
      balance.availableMinor -= amountMinor;
      state.balances.set(input.accountId, balance);
      for (let hour = settledHours + 1; hour <= elapsedHours; hour++) {
        state.ledger.push({
          ledgerEntryId: this.createId("ledger"),
          accountId: input.accountId,
          kind: "shared_runtime_fee",
          amount: {
            currency: this.currency,
            amountMinor: selected.hourlyAmountMinor,
          },
          occurredAt: input.settledAt,
          referenceId:
            `shared-runtime:${input.serviceId}:${input.assignmentId}:hour:${hour}`,
        });
      }
      const response: SharedHostingRuntimeCharge = {
        status: "settled",
        chargedHours: elapsedHours,
        amountMinor,
        rateVersion: selected.hourlyRateVersion,
      };
      state.sharedRuntimeWatermarks.set(input.serviceId, {
        assignmentId: input.assignmentId,
        startedAt: input.startedAt,
        settledHours: elapsedHours,
      });
      state.idempotencies.set(scope, { fingerprint, response });
      return response;
    });
  }
  async subscribe(input: {
    accountId: string;
    planId: string;
    regionId?: string;
    idempotencyKey: string;
  }): Promise<PublicSharedHostingSubscription> {
    if (!input.accountId || !input.idempotencyKey) {
      throw new AccountError(422, "invalid_shared_subscription");
    }
    const selected = plan(input.planId);
    const selectedRegion = requireSharedHostingRegion(
      input.regionId ?? this.enabledRegions[0].regionId,
      this.enabledRegions,
    );
    const fingerprint = stableFingerprint({
      planId: selected.planId,
      regionId: selectedRegion.regionId,
    });
    return await this.store.transaction((state) => {
      const scope = idempotencyScope(
        input.accountId,
        "shared_subscribe",
        input.idempotencyKey,
      );
      const replay = state.idempotencies.get(scope);
      if (replay) {
        if (replay.fingerprint !== fingerprint) {
          throw new AccountError(409, "idempotency_conflict");
        }
        return replay.response as PublicSharedHostingSubscription;
      }
      const now = this.now();
      const periodEnd = addCalendarMonth(now);
      const subscription: SharedHostingSubscription = {
        subscriptionId: this.createId("shared"),
        accountId: input.accountId,
        planId: selected.planId,
        regionId: selectedRegion.regionId,
        status: "active",
        currentPeriodStartedAt: now.toISOString(),
        currentPeriodEndsAt: periodEnd.toISOString(),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      this.chargeBaseFee(
        state,
        subscription,
        selected,
        `subscription:${subscription.subscriptionId}:${subscription.currentPeriodStartedAt}`,
      );
      state.sharedHostingSubscriptions.set(
        subscription.subscriptionId,
        subscription,
      );
      const response = publicSubscription(subscription, this.currency);
      state.idempotencies.set(scope, { fingerprint, response });
      return response;
    });
  }

  async cancel(
    accountId: string,
    subscriptionId: string,
    idempotencyKey: string,
  ): Promise<PublicSharedHostingSubscription> {
    if (!accountId || !subscriptionId || !idempotencyKey) {
      throw new AccountError(422, "invalid_shared_subscription");
    }
    return await this.store.transaction((state) => {
      const scope = idempotencyScope(
        accountId,
        "shared_cancel",
        idempotencyKey,
      );
      const fingerprint = stableFingerprint({ subscriptionId });
      const replay = state.idempotencies.get(scope);
      if (replay) {
        if (replay.fingerprint !== fingerprint) {
          throw new AccountError(409, "idempotency_conflict");
        }
        return replay.response as PublicSharedHostingSubscription;
      }
      const subscription = state.sharedHostingSubscriptions.get(
        subscriptionId,
      ) as SharedHostingSubscription | undefined;
      if (!subscription || subscription.accountId !== accountId) {
        throw new AccountError(404, "shared_subscription_not_found");
      }
      if (subscription.status === "cancelled") {
        throw new AccountError(409, "shared_subscription_cancelled");
      }
      subscription.cancelAtPeriodEnd = true;
      subscription.updatedAt = this.now().toISOString();
      const response = publicSubscription(subscription, this.currency);
      state.idempotencies.set(scope, { fingerprint, response });
      return response;
    });
  }

  /** Called by the billing scheduler. Each renewal is independently atomic. */
  async renewDue(at = this.now()): Promise<{
    renewed: string[];
    paymentDue: string[];
    cancelled: string[];
  }> {
    const ids = await this.store.read((state) =>
      [...state.sharedHostingSubscriptions.values()]
        .map((item) => item as SharedHostingSubscription)
        .filter((item) =>
          item.status === "active" &&
          Date.parse(item.currentPeriodEndsAt) <= at.getTime()
        )
        .map((item) => item.subscriptionId)
    );
    const result = {
      renewed: [] as string[],
      paymentDue: [] as string[],
      cancelled: [] as string[],
    };
    for (const subscriptionId of ids) {
      const outcome = await this.renew(subscriptionId, at);
      result[outcome].push(subscriptionId);
    }
    return result;
  }

  private async renew(
    subscriptionId: string,
    at: Date,
  ): Promise<"renewed" | "paymentDue" | "cancelled"> {
    return await this.store.transaction((state) => {
      const subscription = state.sharedHostingSubscriptions.get(
        subscriptionId,
      ) as SharedHostingSubscription | undefined;
      if (
        !subscription || subscription.status !== "active" ||
        Date.parse(subscription.currentPeriodEndsAt) > at.getTime()
      ) {
        return "cancelled";
      }
      if (subscription.cancelAtPeriodEnd) {
        this.markCancelled(subscription, at);
        return "cancelled";
      }
      const selected = plan(subscription.planId);
      const balance = state.balances.get(subscription.accountId) ?? {
        availableMinor: 0,
        reservedMinor: 0,
      };
      if (balance.availableMinor < selected.monthlyBaseMinor) {
        subscription.status = "payment_due";
        subscription.updatedAt = at.toISOString();
        return "paymentDue";
      }
      subscription.currentPeriodStartedAt = subscription.currentPeriodEndsAt;
      subscription.currentPeriodEndsAt = addCalendarMonth(
        new Date(subscription.currentPeriodEndsAt),
      ).toISOString();
      subscription.updatedAt = at.toISOString();
      this.chargeBaseFee(
        state,
        subscription,
        selected,
        `subscription:${subscription.subscriptionId}:${subscription.currentPeriodStartedAt}`,
      );
      return "renewed";
    });
  }

  private chargeBaseFee(
    state: Parameters<BillingStore["transaction"]>[0] extends (
      state: infer T,
    ) => unknown ? T
      : never,
    subscription: SharedHostingSubscription,
    selected: SharedHostingPlan,
    referenceId: string,
  ) {
    requirePositiveSafeInteger(selected.monthlyBaseMinor);
    const balance = state.balances.get(subscription.accountId) ?? {
      availableMinor: 0,
      reservedMinor: 0,
    };
    if (balance.availableMinor < selected.monthlyBaseMinor) {
      throw new AccountError(422, "insufficient_balance");
    }
    balance.availableMinor -= selected.monthlyBaseMinor;
    state.balances.set(subscription.accountId, balance);
    const entry: LedgerEntry = {
      ledgerEntryId: this.createId("ledger"),
      accountId: subscription.accountId,
      kind: "shared_base_fee",
      amount: {
        currency: this.currency,
        amountMinor: selected.monthlyBaseMinor,
      },
      occurredAt: this.now().toISOString(),
      referenceId,
    };
    state.ledger.push(entry);
  }
}
