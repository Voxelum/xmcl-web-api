import type { BillingStore, TurnCredentialIssuance } from "./ledger.ts";
import {
  activeTurnAllowanceSource,
  allowanceSourceKey,
} from "./xmclPlus.ts";

const ANALYTICS_DELAY_MS = 2 * 60 * 1_000;
const FINALIZATION_WINDOW_MS = 2 * 60 * 60 * 1_000;

export interface TurnAnalyticsConfig {
  accountId: string;
  apiToken: string;
}

export interface TurnMeteringSweepResult {
  queried: number;
  settledCredentials: number;
  settledEgressBytes: number;
}

export interface TurnCredentialAuthorization {
  customIdentifier: string;
  created: boolean;
  ttlSeconds: number;
}

export class TurnCredentialMeter {
  constructor(
    private readonly store: BillingStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async authorize(
    accountId: string,
    customIdentifier: string,
    ttlSeconds: number,
  ): Promise<TurnCredentialAuthorization | undefined> {
    const now = this.now();
    return await this.store.transaction((state) => {
      const source = activeTurnAllowanceSource(state, accountId, now);
      if (!source) return undefined;
      const key = allowanceSourceKey(source);
      const expiresAt = new Date(
        Math.min(
          now.getTime() + ttlSeconds * 1_000,
          Date.parse(source.periodEndsAt),
        ),
      );
      const effectiveTtlSeconds = Math.max(
        1,
        Math.ceil((expiresAt.getTime() - now.getTime()) / 1_000),
      );
      const activeCredential = [...state.turnCredentialIssuances.values()]
        .find((issuance) =>
          issuance.accountId === accountId &&
          issuance.sourceKey === key &&
          Date.parse(issuance.expiresAt) > now.getTime()
        );
      if (activeCredential) {
        const renewedExpiry = expiresAt.toISOString();
        if (renewedExpiry > activeCredential.expiresAt) {
          activeCredential.expiresAt = renewedExpiry;
          state.turnCredentialIssuances.set(
            activeCredential.customIdentifier,
            activeCredential,
          );
        }
        return {
          customIdentifier: activeCredential.customIdentifier,
          created: false,
          ttlSeconds: effectiveTtlSeconds,
        };
      }
      if (
        (state.allowanceUsage.get(key)?.turnEgressBytes ?? 0) >=
          source.turnEgressBytes
      ) return undefined;
      state.turnCredentialIssuances.set(customIdentifier, {
        customIdentifier,
        accountId,
        sourceKey: key,
        issuedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        observedEgressBytes: 0,
      });
      state.turnMeteringEnabled = true;
      return {
        customIdentifier,
        created: true,
        ttlSeconds: effectiveTtlSeconds,
      };
    });
  }

  async release(customIdentifier: string): Promise<void> {
    await this.store.transaction((state) => {
      state.turnCredentialIssuances.delete(customIdentifier);
    });
  }

  async dueForAnalytics(at: Date): Promise<TurnCredentialIssuance[]> {
    const cutoff = at.getTime() - ANALYTICS_DELAY_MS;
    return await this.store.read((state) =>
      [...state.turnCredentialIssuances.values()].filter((issuance) =>
        Date.parse(issuance.issuedAt) < cutoff &&
        Date.parse(issuance.expiresAt) + FINALIZATION_WINDOW_MS > at.getTime()
      )
    );
  }

  async settle(
    customIdentifier: string,
    cumulativeEgressBytes: number,
  ): Promise<number> {
    if (
      !Number.isSafeInteger(cumulativeEgressBytes) ||
      cumulativeEgressBytes < 0
    ) throw new Error("Invalid TURN egress byte count");
    return await this.store.transaction((state) => {
      const issuance = state.turnCredentialIssuances.get(customIdentifier);
      if (!issuance) return 0;
      const delta = Math.max(
        0,
        cumulativeEgressBytes - issuance.observedEgressBytes,
      );
      if (delta === 0) return 0;
      const usage = state.allowanceUsage.get(issuance.sourceKey) ?? {
        aiUnits: 0,
        turnEgressBytes: 0,
      };
      usage.turnEgressBytes += delta;
      state.allowanceUsage.set(issuance.sourceKey, usage);
      issuance.observedEgressBytes = cumulativeEgressBytes;
      state.turnCredentialIssuances.set(customIdentifier, issuance);
      return delta;
    });
  }

  async pruneFinalized(at: Date): Promise<void> {
    await this.store.transaction((state) => {
      for (const [identifier, issuance] of state.turnCredentialIssuances) {
        if (
          Date.parse(issuance.expiresAt) + FINALIZATION_WINDOW_MS <=
            at.getTime()
        ) {
          state.turnCredentialIssuances.delete(identifier);
        }
      }
    });
  }
}

async function queryCredentialEgress(
  issuance: TurnCredentialIssuance,
  config: TurnAnalyticsConfig,
  at: Date,
  fetcher: typeof fetch,
): Promise<number> {
  const end = new Date(
    Math.min(at.getTime() - ANALYTICS_DELAY_MS, Date.parse(issuance.expiresAt)),
  );
  const query =
    `query TurnUsage($accountId: String!, $start: Time!, $end: Time!, $identifier: String!) {
    viewer {
      accounts(filter: { accountTag: $accountId }) {
        usage: callsTurnUsageAdaptiveGroups(
          limit: 1
          filter: {
            datetimeMinute_gt: $start
            datetimeMinute_lt: $end
            customIdentifier: $identifier
          }
        ) {
          sum { egressBytes }
        }
      }
    }
  }`;
  const response = await fetcher(
    "https://api.cloudflare.com/client/v4/graphql",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: {
          accountId: config.accountId,
          start: issuance.issuedAt,
          end: end.toISOString(),
          identifier: issuance.customIdentifier,
        },
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Cloudflare TURN Analytics returned ${response.status}`);
  }
  const body = await response.json() as {
    data?: {
      viewer?: {
        accounts?: Array<{
          usage?: Array<{ sum?: { egressBytes?: unknown } }>;
        }>;
      };
    };
    errors?: Array<{ message?: unknown }>;
  };
  if (body.errors?.length) {
    throw new Error("Cloudflare TURN Analytics rejected the query");
  }
  const value =
    body.data?.viewer?.accounts?.[0]?.usage?.[0]?.sum?.egressBytes ??
      0;
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error("Cloudflare TURN Analytics returned invalid egress");
  }
  return bytes;
}

export async function runTurnMeteringSweep(
  meter: TurnCredentialMeter,
  config: TurnAnalyticsConfig,
  at = new Date(),
  fetcher: typeof fetch = fetch,
): Promise<TurnMeteringSweepResult> {
  const issuances = await meter.dueForAnalytics(at);
  let settledCredentials = 0;
  let settledEgressBytes = 0;
  for (const issuance of issuances) {
    const cumulative = await queryCredentialEgress(
      issuance,
      config,
      at,
      fetcher,
    );
    const settled = await meter.settle(
      issuance.customIdentifier,
      cumulative,
    );
    if (settled > 0) settledCredentials += 1;
    settledEgressBytes += settled;
  }
  await meter.pruneFinalized(at);
  return {
    queried: issuances.length,
    settledCredentials,
    settledEgressBytes,
  };
}
