import { requirePositiveSafeInteger, stableFingerprint } from "./billing.ts";
import type {
  AiAllowanceReservation,
  BillingState,
  BillingStore,
} from "./ledger.ts";
import type { SharedHostingSubscription } from "./sharedHosting.ts";
import {
  XMCL_PLUS_OFFER,
  allowanceSourceKey,
  type XmclPlusAllowanceSource,
  type XmclPlusSubscription,
} from "./xmclPlus.ts";

export const AI_USAGE_FORMULA_VERSION = 1;

export interface OpenAiTokenUsage {
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
}

export interface AiAllowanceSettlement {
  authorizationId: string;
  usageId: string;
  weightedUnits: number;
}

export interface AiSettlementSweepResult {
  settled: string[];
  failed: Array<{ authorizationId: string; error: string }>;
}

function activeSources(
  state: BillingState,
  accountId: string,
  now: number,
): XmclPlusAllowanceSource[] {
  const sources: XmclPlusAllowanceSource[] = [];
  for (
    const subscription of state.plusSubscriptions.values() as Iterable<
      XmclPlusSubscription
    >
  ) {
    if (
      subscription.accountId === accountId &&
      subscription.status === "active" &&
      Date.parse(subscription.currentPeriodStartedAt) <= now &&
      Date.parse(subscription.currentPeriodEndsAt) > now
    ) {
      sources.push({
        source: "plus",
        referenceId: subscription.subscriptionId,
        aiUnits: XMCL_PLUS_OFFER.aiUnitsPerPeriod,
        turnEgressBytes: XMCL_PLUS_OFFER.turnEgressBytesPerPeriod,
        periodStartedAt: subscription.currentPeriodStartedAt,
        periodEndsAt: subscription.currentPeriodEndsAt,
      });
    }
  }
  for (
    const subscription of state.sharedHostingSubscriptions.values() as Iterable<
      SharedHostingSubscription
    >
  ) {
    if (
      subscription.accountId === accountId &&
      subscription.status === "active" &&
      Date.parse(subscription.currentPeriodStartedAt) <= now &&
      Date.parse(subscription.currentPeriodEndsAt) > now
    ) {
      sources.push({
        source: "shared_hosting",
        referenceId: subscription.subscriptionId,
        aiUnits: XMCL_PLUS_OFFER.serverAiUnitsPerPeriod,
        turnEgressBytes: 0,
        periodStartedAt: subscription.currentPeriodStartedAt,
        periodEndsAt: subscription.currentPeriodEndsAt,
      });
    }
  }
  return sources.sort((left, right) =>
    left.periodEndsAt.localeCompare(right.periodEndsAt) ||
    left.referenceId.localeCompare(right.referenceId)
  );
}

function reservedBySource(state: BillingState): Map<string, number> {
  const reserved = new Map<string, number>();
  for (const reservation of state.aiAllowanceReservations.values()) {
    for (const allocation of reservation.allocations) {
      reserved.set(
        allocation.sourceKey,
        (reserved.get(allocation.sourceKey) ?? 0) + allocation.units,
      );
    }
  }
  return reserved;
}

export function weightedAiUnits(usage: OpenAiTokenUsage): number {
  for (const value of Object.values(usage)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Invalid AI token usage");
    }
  }
  if (usage.cachedPromptTokens > usage.promptTokens) {
    throw new Error("Cached prompt tokens exceed total prompt tokens");
  }
  const units = usage.promptTokens - usage.cachedPromptTokens +
    Math.ceil(usage.cachedPromptTokens * 0.1) +
    usage.completionTokens * 4;
  if (!Number.isSafeInteger(units)) {
    throw new Error("AI token usage exceeds the supported range");
  }
  return units;
}

export class AllowanceMeter {
  constructor(
    private readonly store: BillingStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async reserveAi(
    accountId: string,
    authorizationId: string,
    maximumUnits: number,
  ): Promise<boolean> {
    requirePositiveSafeInteger(maximumUnits, "invalid_ai_reservation");
    return await this.store.transaction((state) => {
      const staleBefore = this.now().getTime() - 60 * 60 * 1_000;
      for (const [id, reservation] of state.aiAllowanceReservations) {
        if (
          !reservation.pendingSettlement &&
          Date.parse(reservation.createdAt) < staleBefore
        ) {
          state.aiAllowanceReservations.delete(id);
        }
      }
      const existing = state.aiAllowanceReservations.get(authorizationId);
      if (existing) {
        return existing.accountId === accountId &&
          existing.maximumUnits === maximumUnits;
      }
      const reserved = reservedBySource(state);
      const allocations: AiAllowanceReservation["allocations"] = [];
      let needed = maximumUnits;
      for (const source of activeSources(
        state,
        accountId,
        this.now().getTime(),
      )) {
        const key = allowanceSourceKey(source);
        const consumed = state.allowanceUsage.get(key)?.aiUnits ?? 0;
        const available = Math.max(
          0,
          source.aiUnits - consumed - (reserved.get(key) ?? 0),
        );
        const units = Math.min(available, needed);
        if (units > 0) allocations.push({ sourceKey: key, units });
        needed -= units;
        if (needed === 0) break;
      }
      if (needed > 0) return false;
      state.aiAllowanceReservations.set(authorizationId, {
        authorizationId,
        accountId,
        allocations,
        maximumUnits,
        createdAt: this.now().toISOString(),
      });
      return true;
    });
  }

  async releaseAi(authorizationId: string): Promise<void> {
    await this.store.transaction((state) => {
      state.aiAllowanceReservations.delete(authorizationId);
    });
  }

  async recordAiDelivery(
    authorizationId: string,
    usageId: string,
    usage: OpenAiTokenUsage,
  ): Promise<void> {
    const weightedUnits = weightedAiUnits(usage);
    await this.store.transaction((state) => {
      const reservation = state.aiAllowanceReservations.get(authorizationId);
      if (!reservation) throw new Error("AI allowance reservation is missing");
      if (weightedUnits > reservation.maximumUnits) {
        throw new Error("AI usage exceeded its allowance reservation");
      }
      const pending = reservation.pendingSettlement;
      if (pending) {
        if (
          pending.usageId !== usageId ||
          stableFingerprint(pending.usage) !== stableFingerprint(usage)
        ) {
          throw new Error("Conflicting AI delivery record");
        }
        return;
      }
      reservation.pendingSettlement = {
        usageId,
        usage: structuredClone(usage),
        recordedAt: this.now().toISOString(),
      };
    });
  }

  async settlePendingAi(limit = 100): Promise<AiSettlementSweepResult> {
    requirePositiveSafeInteger(limit, "invalid_ai_settlement_limit");
    const pending = await this.store.read((state) =>
      [...state.aiAllowanceReservations.values()]
        .filter((reservation) => reservation.pendingSettlement)
        .sort((left, right) =>
          left.pendingSettlement!.recordedAt.localeCompare(
            right.pendingSettlement!.recordedAt,
          )
        )
        .slice(0, limit)
        .map((reservation) => ({
          authorizationId: reservation.authorizationId,
          ...reservation.pendingSettlement!,
        }))
    );
    const result: AiSettlementSweepResult = { settled: [], failed: [] };
    for (const item of pending) {
      try {
        await this.settleAi(item.authorizationId, item.usageId, item.usage);
        result.settled.push(item.authorizationId);
      } catch (error) {
        result.failed.push({
          authorizationId: item.authorizationId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  }

  async settleAi(
    authorizationId: string,
    usageId: string,
    usage: OpenAiTokenUsage,
  ): Promise<AiAllowanceSettlement> {
    const weightedUnits = weightedAiUnits(usage);
    const fingerprint = stableFingerprint({
      authorizationId,
      usage,
      formulaVersion: AI_USAGE_FORMULA_VERSION,
    });
    return await this.store.transaction((state) => {
      const idempotencyKey = `ai-usage:${usageId}`;
      const replay = state.idempotencies.get(idempotencyKey);
      if (replay) {
        if (replay.fingerprint !== fingerprint) {
          throw new Error("Conflicting AI usage event");
        }
        return replay.response as AiAllowanceSettlement;
      }
      const reservation = state.aiAllowanceReservations.get(authorizationId);
      if (!reservation) throw new Error("AI allowance reservation is missing");
      const pending = reservation.pendingSettlement;
      if (
        pending &&
        (pending.usageId !== usageId ||
          stableFingerprint(pending.usage) !== stableFingerprint(usage))
      ) {
        throw new Error("Conflicting AI delivery record");
      }
      if (weightedUnits > reservation.maximumUnits) {
        throw new Error("AI usage exceeded its allowance reservation");
      }
      let remaining = weightedUnits;
      for (const allocation of reservation.allocations) {
        const units = Math.min(allocation.units, remaining);
        if (units === 0) continue;
        const current = state.allowanceUsage.get(allocation.sourceKey) ?? {
          aiUnits: 0,
          turnEgressBytes: 0,
        };
        current.aiUnits += units;
        state.allowanceUsage.set(allocation.sourceKey, current);
        remaining -= units;
      }
      if (remaining !== 0) throw new Error("AI reservation is incomplete");
      state.aiAllowanceReservations.delete(authorizationId);
      const result = { authorizationId, usageId, weightedUnits };
      state.idempotencies.set(idempotencyKey, {
        fingerprint,
        response: result,
      });
      return result;
    });
  }
}
