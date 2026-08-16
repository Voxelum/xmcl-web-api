import { AccountError, randomId } from "./account.ts";
import { requirePositiveSafeInteger, stableFingerprint } from "./billing.ts";
import type {
  BillingState,
  BillingStore,
  LedgerEntry,
  Money,
} from "./ledger.ts";
import type { SharedHostingSubscription } from "./sharedHosting.ts";

export const XMCL_PLUS_OFFER = {
  offerId: "xmcl-plus",
  displayName: "XMCL Together Home",
  monthlyPriceMinor: 299,
  aiUnitsPerPeriod: 2_000_000,
  turnEgressBytesPerPeriod: 20_000_000_000,
  serverAiUnitsPerPeriod: 200_000,
} as const;

export const XMCL_PLUS_TRIAL = {
  offerId: "xmcl-plus-trial",
  durationSeconds: 7 * 24 * 60 * 60,
  turnEgressBytes: 1_000_000_000,
} as const;

export type XmclPlusSubscriptionStatus =
  | "active"
  | "payment_due"
  | "cancelled";

export interface XmclPlusSubscription {
  subscriptionId: string;
  accountId: string;
  status: XmclPlusSubscriptionStatus;
  currentPeriodStartedAt: string;
  currentPeriodEndsAt: string;
  createdAt: string;
  updatedAt: string;
  cancelAtPeriodEnd?: true;
}

export interface XmclPlusTrial {
  status: "available" | "active" | "expired" | "unavailable";
  durationSeconds: number;
  turnEgressBytes: number;
  claimedAt?: string;
  expiresAt?: string;
}

export type PublicXmclPlusOffer = typeof XMCL_PLUS_OFFER & {
  currency: string;
  monthlyPrice: Money;
};

export interface XmclPlusAllowanceSource {
  source: "plus" | "shared_hosting" | "trial";
  referenceId: string;
  aiUnits: number;
  turnEgressBytes: number;
  periodStartedAt: string;
  periodEndsAt: string;
}

export function allowanceSourceKey(source: XmclPlusAllowanceSource): string {
  return [
    source.source,
    source.referenceId,
    source.periodStartedAt,
  ].join(":");
}

export interface XmclPlusAllowances {
  sources: XmclPlusAllowanceSource[];
  aiUnits: {
    included: number;
    consumed: number;
    remaining: number;
    meteringStatus: "active";
  };
  turnEgressBytes: {
    included: number;
    consumed: number;
    remaining: number;
    meteringStatus: "not_configured" | "active";
  };
}

export interface XmclPlusServiceOptions {
  currency?: string;
  now?: () => Date;
  createId?: (prefix: string) => string;
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

function scope(accountId: string, operation: string, key: string) {
  return `${accountId}:${operation}:${key}`;
}

export function xmclPlusTrialStatus(
  state: BillingState,
  accountId: string,
  now = new Date(),
): XmclPlusTrial {
  const stored = state.plusTrials.get(accountId) as XmclPlusTrial | undefined;
  if (stored?.claimedAt && stored.expiresAt) {
    return {
      ...stored,
      status: Date.parse(stored.expiresAt) > now.getTime()
        ? "active"
        : "expired",
    };
  }
  const hasSubscription = [...state.plusSubscriptions.values()]
    .map((value) => value as XmclPlusSubscription)
    .some((value) => value.accountId === accountId);
  return {
    status: hasSubscription ? "unavailable" : "available",
    durationSeconds: XMCL_PLUS_TRIAL.durationSeconds,
    turnEgressBytes: XMCL_PLUS_TRIAL.turnEgressBytes,
  };
}

export function activeTurnAllowanceSource(
  state: BillingState,
  accountId: string,
  now = new Date(),
): XmclPlusAllowanceSource | undefined {
  const subscription = [...state.plusSubscriptions.values()]
    .map((value) => value as XmclPlusSubscription)
    .find((value) =>
      value.accountId === accountId &&
      value.status === "active" &&
      (value.currentPeriodStartedAt === undefined ||
        Date.parse(value.currentPeriodStartedAt) <= now.getTime()) &&
      Date.parse(value.currentPeriodEndsAt) > now.getTime()
    );
  if (subscription) {
    return {
      source: "plus",
      referenceId: subscription.subscriptionId,
      aiUnits: XMCL_PLUS_OFFER.aiUnitsPerPeriod,
      turnEgressBytes: XMCL_PLUS_OFFER.turnEgressBytesPerPeriod,
      periodStartedAt: subscription.currentPeriodStartedAt,
      periodEndsAt: subscription.currentPeriodEndsAt,
    };
  }
  const trial = xmclPlusTrialStatus(state, accountId, now);
  if (trial.status !== "active") return undefined;
  return {
    source: "trial",
    referenceId: XMCL_PLUS_TRIAL.offerId,
    aiUnits: 0,
    turnEgressBytes: trial.turnEgressBytes,
    periodStartedAt: trial.claimedAt!,
    periodEndsAt: trial.expiresAt!,
  };
}

export class XmclPlusService {
  private readonly currency: string;
  private readonly now: () => Date;
  private readonly createId: (prefix: string) => string;

  constructor(
    private readonly store: BillingStore,
    options: XmclPlusServiceOptions = {},
  ) {
    this.currency = options.currency ?? "USD";
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomId;
  }

  offer(): PublicXmclPlusOffer {
    return {
      ...XMCL_PLUS_OFFER,
      currency: this.currency,
      monthlyPrice: {
        currency: this.currency,
        amountMinor: XMCL_PLUS_OFFER.monthlyPriceMinor,
      },
    };
  }

  async status(accountId: string): Promise<XmclPlusSubscription | null> {
    return await this.store.read((state) =>
      [...state.plusSubscriptions.values()]
        .map((value) => value as XmclPlusSubscription)
        .filter((value) => value.accountId === accountId)
        .sort((left, right) =>
          right.createdAt.localeCompare(left.createdAt)
        )[0] ??
        null
    );
  }

  async trialStatus(accountId: string): Promise<XmclPlusTrial> {
    return await this.store.read((state) =>
      xmclPlusTrialStatus(state, accountId, this.now())
    );
  }

  async claimTrial(input: {
    accountId: string;
    idempotencyKey: string;
  }): Promise<XmclPlusTrial> {
    if (!input.accountId || !input.idempotencyKey) {
      throw new AccountError(422, "invalid_plus_trial");
    }
    return await this.store.transaction((state) => {
      const idempotencyScope = scope(
        input.accountId,
        "plus_trial",
        input.idempotencyKey,
      );
      const fingerprint = stableFingerprint({
        offerId: XMCL_PLUS_TRIAL.offerId,
      });
      const replay = state.idempotencies.get(idempotencyScope);
      if (replay) {
        if (replay.fingerprint !== fingerprint) {
          throw new AccountError(409, "idempotency_conflict");
        }
        return replay.response as XmclPlusTrial;
      }
      const current = xmclPlusTrialStatus(state, input.accountId, this.now());
      if (current.status !== "available") {
        state.idempotencies.set(idempotencyScope, {
          fingerprint,
          response: current,
        });
        return current;
      }
      const claimedAt = this.now();
      const trial: XmclPlusTrial = {
        status: "active",
        durationSeconds: XMCL_PLUS_TRIAL.durationSeconds,
        turnEgressBytes: XMCL_PLUS_TRIAL.turnEgressBytes,
        claimedAt: claimedAt.toISOString(),
        expiresAt: new Date(
          claimedAt.getTime() + XMCL_PLUS_TRIAL.durationSeconds * 1_000,
        ).toISOString(),
      };
      state.plusTrials.set(input.accountId, trial);
      state.idempotencies.set(idempotencyScope, {
        fingerprint,
        response: trial,
      });
      return trial;
    });
  }

  async adminSubscriptions(): Promise<XmclPlusSubscription[]> {
    return await this.store.read((state) =>
      [...state.plusSubscriptions.values()]
        .map((value) => structuredClone(value as XmclPlusSubscription))
        .sort((left, right) =>
          left.accountId.localeCompare(right.accountId) ||
          right.createdAt.localeCompare(left.createdAt)
        )
    );
  }

  async allowances(accountId: string): Promise<XmclPlusAllowances> {
    return await this.store.read((state) => {
      const sources: XmclPlusAllowanceSource[] = [];
      const now = this.now().getTime();
      const trial = xmclPlusTrialStatus(state, accountId, this.now());
      if (trial.status === "active") {
        sources.push({
          source: "trial",
          referenceId: XMCL_PLUS_TRIAL.offerId,
          aiUnits: 0,
          turnEgressBytes: trial.turnEgressBytes,
          periodStartedAt: trial.claimedAt!,
          periodEndsAt: trial.expiresAt!,
        });
      }
      const plus = [...state.plusSubscriptions.values()]
        .map((value) => value as XmclPlusSubscription)
        .find((value) =>
          value.accountId === accountId && value.status === "active" &&
          Date.parse(value.currentPeriodStartedAt) <= now &&
          Date.parse(value.currentPeriodEndsAt) > now
        );
      if (plus) {
        sources.push({
          source: "plus",
          referenceId: plus.subscriptionId,
          aiUnits: XMCL_PLUS_OFFER.aiUnitsPerPeriod,
          turnEgressBytes: XMCL_PLUS_OFFER.turnEgressBytesPerPeriod,
          periodStartedAt: plus.currentPeriodStartedAt,
          periodEndsAt: plus.currentPeriodEndsAt,
        });
      }
      const hosting = [...state.sharedHostingSubscriptions.values()]
        .map((value) => value as SharedHostingSubscription)
        .filter((value) =>
          value.accountId === accountId && value.status === "active" &&
          Date.parse(value.currentPeriodStartedAt) <= now &&
          Date.parse(value.currentPeriodEndsAt) > now
        );
      for (const subscription of hosting) {
        sources.push({
          source: "shared_hosting",
          referenceId: subscription.subscriptionId,
          aiUnits: XMCL_PLUS_OFFER.serverAiUnitsPerPeriod,
          turnEgressBytes: 0,
          periodStartedAt: subscription.currentPeriodStartedAt,
          periodEndsAt: subscription.currentPeriodEndsAt,
        });
      }
      const aiIncluded = sources.reduce((sum, value) => sum + value.aiUnits, 0);
      const turnIncluded = sources.reduce(
        (sum, value) => sum + value.turnEgressBytes,
        0,
      );
      const aiConsumed = sources.reduce(
        (sum, value) =>
          sum +
          (state.allowanceUsage.get(allowanceSourceKey(value))?.aiUnits ?? 0),
        0,
      );
      const turnConsumed = sources.reduce(
        (sum, value) =>
          sum +
          (state.allowanceUsage.get(allowanceSourceKey(value))
            ?.turnEgressBytes ?? 0),
        0,
      );
      return {
        sources,
        aiUnits: {
          included: aiIncluded,
          consumed: aiConsumed,
          remaining: Math.max(0, aiIncluded - aiConsumed),
          meteringStatus: "active",
        },
        turnEgressBytes: {
          included: turnIncluded,
          consumed: turnConsumed,
          remaining: Math.max(0, turnIncluded - turnConsumed),
          meteringStatus: state.turnMeteringEnabled
            ? "active"
            : "not_configured",
        },
      };
    });
  }

  async subscribe(input: {
    accountId: string;
    idempotencyKey: string;
  }): Promise<XmclPlusSubscription> {
    if (!input.accountId || !input.idempotencyKey) {
      throw new AccountError(422, "invalid_plus_subscription");
    }
    const fingerprint = stableFingerprint({ offerId: XMCL_PLUS_OFFER.offerId });
    return await this.store.transaction((state) => {
      const idempotencyScope = scope(
        input.accountId,
        "plus_subscribe",
        input.idempotencyKey,
      );
      const replay = state.idempotencies.get(idempotencyScope);
      if (replay) {
        if (replay.fingerprint !== fingerprint) {
          throw new AccountError(409, "idempotency_conflict");
        }
        return replay.response as XmclPlusSubscription;
      }
      const existing = [...state.plusSubscriptions.values()]
        .map((value) => value as XmclPlusSubscription)
        .find((value) =>
          value.accountId === input.accountId &&
          (value.status === "active" || value.status === "payment_due")
        );
      if (existing) throw new AccountError(409, "plus_subscription_exists");

      const now = this.now();
      const subscription: XmclPlusSubscription = {
        subscriptionId: this.createId("plus"),
        accountId: input.accountId,
        status: "active",
        currentPeriodStartedAt: now.toISOString(),
        currentPeriodEndsAt: addCalendarMonth(now).toISOString(),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      this.charge(state, subscription);
      state.plusSubscriptions.set(subscription.subscriptionId, subscription);
      state.idempotencies.set(idempotencyScope, {
        fingerprint,
        response: subscription,
      });
      return subscription;
    });
  }

  async cancel(
    accountId: string,
    idempotencyKey: string,
  ): Promise<XmclPlusSubscription> {
    if (!accountId || !idempotencyKey) {
      throw new AccountError(422, "invalid_plus_subscription");
    }
    const fingerprint = stableFingerprint({ offerId: XMCL_PLUS_OFFER.offerId });
    return await this.store.transaction((state) => {
      const idempotencyScope = scope(
        accountId,
        "plus_cancel",
        idempotencyKey,
      );
      const replay = state.idempotencies.get(idempotencyScope);
      if (replay) {
        if (replay.fingerprint !== fingerprint) {
          throw new AccountError(409, "idempotency_conflict");
        }
        return replay.response as XmclPlusSubscription;
      }
      const subscription = [...state.plusSubscriptions.values()]
        .map((value) => value as XmclPlusSubscription)
        .find((value) =>
          value.accountId === accountId && value.status !== "cancelled"
        );
      if (!subscription) {
        throw new AccountError(404, "plus_subscription_not_found");
      }
      subscription.cancelAtPeriodEnd = true;
      subscription.updatedAt = this.now().toISOString();
      state.plusSubscriptions.set(subscription.subscriptionId, subscription);
      state.idempotencies.set(idempotencyScope, {
        fingerprint,
        response: subscription,
      });
      return subscription;
    });
  }

  async renewDue(at = this.now()) {
    const ids = await this.store.read((state) =>
      [...state.plusSubscriptions.values()]
        .map((value) => value as XmclPlusSubscription)
        .filter((value) =>
          value.status === "active" &&
          Date.parse(value.currentPeriodEndsAt) <= at.getTime()
        )
        .map((value) => value.subscriptionId)
    );
    const result = {
      renewed: [] as string[],
      paymentDue: [] as string[],
      cancelled: [] as string[],
    };
    for (const id of ids) {
      const outcome = await this.renew(id, at);
      result[outcome].push(id);
    }
    return result;
  }

  async recoverPaymentDue(accountId: string, at = this.now()) {
    return await this.store.transaction((state) => {
      const subscription = [...state.plusSubscriptions.values()]
        .map((value) => value as XmclPlusSubscription)
        .find((value) =>
          value.accountId === accountId && value.status === "payment_due"
        );
      if (!subscription) return [] as string[];
      if (subscription.cancelAtPeriodEnd) {
        subscription.status = "cancelled";
        subscription.updatedAt = at.toISOString();
        return [];
      }
      const balance = state.balances.get(accountId) ?? {
        availableMinor: 0,
        reservedMinor: 0,
      };
      if (balance.availableMinor < XMCL_PLUS_OFFER.monthlyPriceMinor) return [];
      subscription.currentPeriodStartedAt = at.toISOString();
      subscription.currentPeriodEndsAt = addCalendarMonth(at).toISOString();
      subscription.status = "active";
      subscription.updatedAt = at.toISOString();
      this.charge(state, subscription);
      return [subscription.subscriptionId];
    });
  }

  private async renew(
    subscriptionId: string,
    at: Date,
  ): Promise<"renewed" | "paymentDue" | "cancelled"> {
    return await this.store.transaction((state) => {
      const subscription = state.plusSubscriptions.get(
        subscriptionId,
      ) as XmclPlusSubscription | undefined;
      if (
        !subscription || subscription.status !== "active" ||
        Date.parse(subscription.currentPeriodEndsAt) > at.getTime()
      ) return "cancelled";
      if (subscription.cancelAtPeriodEnd) {
        subscription.status = "cancelled";
        subscription.updatedAt = at.toISOString();
        return "cancelled";
      }
      const balance = state.balances.get(subscription.accountId) ?? {
        availableMinor: 0,
        reservedMinor: 0,
      };
      if (balance.availableMinor < XMCL_PLUS_OFFER.monthlyPriceMinor) {
        subscription.status = "payment_due";
        subscription.updatedAt = at.toISOString();
        return "paymentDue";
      }
      const previousPeriodEnd = new Date(subscription.currentPeriodEndsAt);
      const nextPeriodStart = previousPeriodEnd.getTime() < at.getTime()
        ? at
        : previousPeriodEnd;
      subscription.currentPeriodStartedAt = nextPeriodStart.toISOString();
      subscription.currentPeriodEndsAt = addCalendarMonth(
        nextPeriodStart,
      ).toISOString();
      subscription.updatedAt = at.toISOString();
      this.charge(state, subscription);
      return "renewed";
    });
  }

  private charge(state: BillingState, subscription: XmclPlusSubscription) {
    requirePositiveSafeInteger(XMCL_PLUS_OFFER.monthlyPriceMinor);
    const balance = state.balances.get(subscription.accountId) ?? {
      availableMinor: 0,
      reservedMinor: 0,
    };
    if (balance.availableMinor < XMCL_PLUS_OFFER.monthlyPriceMinor) {
      throw new AccountError(422, "insufficient_balance");
    }
    balance.availableMinor -= XMCL_PLUS_OFFER.monthlyPriceMinor;
    state.balances.set(subscription.accountId, balance);
    const entry: LedgerEntry = {
      ledgerEntryId: this.createId("ledger"),
      accountId: subscription.accountId,
      kind: "plus_base_fee",
      amount: {
        currency: this.currency,
        amountMinor: XMCL_PLUS_OFFER.monthlyPriceMinor,
      },
      occurredAt: this.now().toISOString(),
      referenceId:
        `subscription:${subscription.subscriptionId}:${subscription.currentPeriodStartedAt}`,
    };
    state.ledger.push(entry);
  }

}
