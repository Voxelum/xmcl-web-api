import type { Context } from "hono";
import { getConfig } from "./config.ts";
import type { AppEnv } from "./types.ts";
import { AccountError } from "./account.ts";
import type { AppConfig } from "./config.ts";
import type { Db } from "./db.ts";
import { BillingService } from "./billing.ts";
import { type CashRate, MongoBillingStore } from "./ledger.ts";
import { UsageSettlementService } from "./usageSettlement.ts";
import { SHARED_HOSTING_RATES, SharedHostingService } from "./sharedHosting.ts";
import { WaffoSdkProvider, WaffoService } from "./waffo.ts";
import { XmclPlusService } from "./xmclPlus.ts";

export interface BillingRuntime {
  billing: BillingService;
  usage: UsageSettlementService;
  sharedHosting: SharedHostingService;
  plus: XmclPlusService;
}

export interface SharedRuntimeSettlementScheduler {
  enforcePaymentDue(subscriptionIds: readonly string[]): Promise<unknown>;
  settleRunningRuntime(at: Date): Promise<{
    settled: string[];
    paymentDue: string[];
  }>;
}

export interface SharedRuntimeSettlementResult {
  renewed: string[];
  paymentDue: string[];
  cancelled: string[];
  runtimeSettled: string[];
  runtimePaymentDue: string[];
  paymentReconciliation: BillingReconciliationResult;
  plusRenewed: string[];
  plusPaymentDue: string[];
  plusCancelled: string[];
}

export interface SharedRuntimeSettlementWork {
  renewDue(at: Date): Promise<SharedRuntimeSettlementResult>;
  runHourly(
    at: Date,
    paymentLimit?: number,
  ): Promise<SharedRuntimeSettlementResult>;
}

export interface BillingReconciliationResult {
  attempted: string[];
  finalized: string[];
  stillPending: string[];
  failed: string[];
}

export interface BillingReconciliationWork {
  reconcilePendingOrders(
    at: Date,
    limit?: number,
  ): Promise<BillingReconciliationResult>;
}

/**
 * Produces trusted scheduled work for a fully composed shared-hosting runtime.
 * Runtime settlement uses durable elapsed-hour watermarks. Repeating an hour is
 * safe; missed invocations catch up through those watermarks.
 */
export function createSharedRuntimeSettlementWork(
  runtime:
    & Pick<BillingRuntime, "sharedHosting">
    & Partial<Pick<BillingRuntime, "plus">>,
  scheduler: SharedRuntimeSettlementScheduler,
  reconciliation?: BillingReconciliationWork,
): SharedRuntimeSettlementWork {
  const runHourly = async (at: Date, paymentLimit?: number) => {
    const [renewal, plusRenewal] = await Promise.all([
      runtime.sharedHosting.renewDue(at),
      runtime.plus?.renewDue(at) ?? Promise.resolve({
        renewed: [] as string[],
        paymentDue: [] as string[],
        cancelled: [] as string[],
      }),
    ]);
    const runtimeSettlement = await scheduler.settleRunningRuntime(at);
    await scheduler.enforcePaymentDue([
      ...new Set([
        ...renewal.paymentDue,
        ...runtimeSettlement.paymentDue,
      ]),
    ]);
    const paymentReconciliation = reconciliation
      ? await reconciliation.reconcilePendingOrders(at, paymentLimit)
      : { attempted: [], finalized: [], stillPending: [], failed: [] };
    return {
      ...renewal,
      runtimeSettled: runtimeSettlement.settled,
      runtimePaymentDue: runtimeSettlement.paymentDue,
      paymentReconciliation,
      plusRenewed: plusRenewal.renewed,
      plusPaymentDue: plusRenewal.paymentDue,
      plusCancelled: plusRenewal.cancelled,
    };
  };
  return {
    runHourly,
    renewDue: runHourly,
  };
}

export function createBillingReconciliationWork(
  payment: Pick<WaffoService, "reconcilePendingOrders">,
): BillingReconciliationWork {
  return {
    reconcilePendingOrders: (at, limit) =>
      payment.reconcilePendingOrders(at, limit),
  };
}

function parseRates(value: string | undefined): CashRate[] {
  if (!value) {
    throw new Error(
      "BILLING_RATES_JSON must be configured before billing is enabled",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("BILLING_RATES_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("BILLING_RATES_JSON must be a JSON array");
  }
  return parsed as CashRate[];
}

/**
 * Builds the durable cash/usage services from platform-owned configuration.
 * Payment-provider composition remains separate because provider callbacks
 * require their own credentials and signature verifier.
 */
export function createBillingRuntime(
  db: Db,
  config: Pick<AppConfig, "BILLING_CURRENCY" | "BILLING_RATES_JSON">,
): BillingRuntime {
  const rates = [
    ...parseRates(config.BILLING_RATES_JSON),
    ...SHARED_HOSTING_RATES,
  ];
  const store = new MongoBillingStore(db);
  const billing = new BillingService(store, {
    currency: config.BILLING_CURRENCY ?? "USD",
    rates,
  });
  return {
    billing,
    usage: new UsageSettlementService(store, billing),
    sharedHosting: new SharedHostingService(store, {
      currency: config.BILLING_CURRENCY ?? "USD",
    }),
    plus: new XmclPlusService(store, {
      currency: config.BILLING_CURRENCY ?? "USD",
    }),
  };
}

export async function getBillingRuntime(
  c: Context<AppEnv>,
): Promise<BillingRuntime> {
  const existing = c.get("billingRuntime");
  if (existing) return existing;
  const runtime = createBillingRuntime(
    await c.get("getDb")(),
    getConfig(c),
  );
  c.set("billingRuntime", runtime);
  c.set("billingService", runtime.billing);
  c.set("sharedHostingService", runtime.sharedHosting);
  c.set("xmclPlusService", runtime.plus);
  c.set("usageSettlementService", runtime.usage);
  return runtime;
}

export async function getWaffoService(
  c: Context<AppEnv>,
): Promise<WaffoService> {
  const existing = c.get("waffoService");
  if (existing) return existing;
  const config = getConfig(c);
  const runtime = await getBillingRuntime(c);
  if (
    !config.WAFFO_MERCHANT_ID || !config.WAFFO_PRIVATE_KEY ||
    !config.WAFFO_STORE_ID ||
    (config.WAFFO_ENVIRONMENT !== "test" &&
      config.WAFFO_ENVIRONMENT !== "prod")
  ) {
    throw new AccountError(503, "waffo_unavailable");
  }
  const service = createWaffoPaymentService(
    runtime.billing,
    config,
    async (accountId, at) => {
      await runtime.plus.recoverPaymentDue(accountId, at);
    },
  );
  c.set("waffoService", service);
  return service;
}

export function createWaffoPaymentService(
  billing: BillingService,
  config: AppConfig,
  recoverPaymentDue?: (accountId: string, at: Date) => Promise<unknown>,
) {
  if (
    !config.WAFFO_MERCHANT_ID || !config.WAFFO_PRIVATE_KEY ||
    !config.WAFFO_STORE_ID ||
    (config.WAFFO_ENVIRONMENT !== "test" &&
      config.WAFFO_ENVIRONMENT !== "prod")
  ) {
    throw new AccountError(503, "waffo_unavailable");
  }
  const options = {
    merchantId: config.WAFFO_MERCHANT_ID,
    privateKey: config.WAFFO_PRIVATE_KEY,
    storeId: config.WAFFO_STORE_ID,
    productId: config.WAFFO_PRODUCT_ID,
    environment: config.WAFFO_ENVIRONMENT,
    successUrl: config.WAFFO_SUCCESS_URL,
    apiBaseUrl: config.WAFFO_API_BASE_URL,
    webhookPublicKey: config.WAFFO_WEBHOOK_PUBLIC_KEY,
  };
  const provider = new WaffoSdkProvider(options);
  return new WaffoService(billing, provider, provider, {
    storeId: options.storeId,
    environment: options.environment,
    recoverPaymentDue,
  });
}
