import type { Context } from "hono";
import { getConfig } from "../config.ts";
import type { AppEnv } from "../types.ts";
import { AccountError } from "./account.ts";
import type { AppConfig } from "../config.ts";
import type { Db } from "../db.ts";
import { BillingService } from "./billing.ts";
import { type CashRate, MongoBillingStore } from "./ledger.ts";
import {
  PayPalHttpProvider,
  PayPalHttpWebhookVerifier,
  PayPalService,
} from "./paypal.ts";
import { UsageSettlementService } from "./usageSettlement.ts";
import { SHARED_HOSTING_RATES, SharedHostingService } from "./sharedHosting.ts";

export interface BillingRuntime {
  billing: BillingService;
  usage: UsageSettlementService;
  sharedHosting: SharedHostingService;
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
  paypalReconciliation: BillingReconciliationResult;
}

export interface SharedRuntimeSettlementWork {
  renewDue(at: Date): Promise<SharedRuntimeSettlementResult>;
  runHourly(
    at: Date,
    paypalLimit?: number,
  ): Promise<SharedRuntimeSettlementResult>;
}

export interface BillingReconciliationResult {
  attempted: string[];
  finalized: string[];
  stillPending: string[];
  failed: string[];
}

export interface BillingReconciliationWork {
  reconcilePendingPayPalOrders(
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
  runtime: Pick<BillingRuntime, "sharedHosting">,
  scheduler: SharedRuntimeSettlementScheduler,
  reconciliation?: BillingReconciliationWork,
): SharedRuntimeSettlementWork {
  const runHourly = async (at: Date, paypalLimit?: number) => {
    const renewal = await runtime.sharedHosting.renewDue(at);
    const runtimeSettlement = await scheduler.settleRunningRuntime(at);
    await scheduler.enforcePaymentDue([
      ...new Set([
        ...renewal.paymentDue,
        ...runtimeSettlement.paymentDue,
      ]),
    ]);
    const paypalReconciliation = reconciliation
      ? await reconciliation.reconcilePendingPayPalOrders(at, paypalLimit)
      : { attempted: [], finalized: [], stillPending: [], failed: [] };
    return {
      ...renewal,
      runtimeSettled: runtimeSettlement.settled,
      runtimePaymentDue: runtimeSettlement.paymentDue,
      paypalReconciliation,
    };
  };
  return {
    runHourly,
    renewDue: runHourly,
  };
}

export function createBillingReconciliationWork(
  paypal: Pick<PayPalService, "reconcilePendingOrders">,
): BillingReconciliationWork {
  return {
    reconcilePendingPayPalOrders: (at, limit) =>
      paypal.reconcilePendingOrders(at, limit),
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
  c.set("usageSettlementService", runtime.usage);
  return runtime;
}

export async function getPayPalService(
  c: Context<AppEnv>,
): Promise<PayPalService> {
  const existing = c.get("paypalService");
  if (existing) return existing;
  const config = getConfig(c);
  const runtime = await getBillingRuntime(c);
  if (
    !config.PAYPAL_CLIENT_ID || !config.PAYPAL_CLIENT_SECRET ||
    !config.PAYPAL_WEBHOOK_ID || !config.PAYPAL_RETURN_URL ||
    !config.PAYPAL_CANCEL_URL
  ) {
    throw new AccountError(503, "paypal_unavailable");
  }
  const options = {
    clientId: config.PAYPAL_CLIENT_ID,
    clientSecret: config.PAYPAL_CLIENT_SECRET,
    webhookId: config.PAYPAL_WEBHOOK_ID,
    returnUrl: config.PAYPAL_RETURN_URL,
    cancelUrl: config.PAYPAL_CANCEL_URL,
    apiBaseUrl: config.PAYPAL_API_BASE_URL,
  };
  const service = new PayPalService(
    runtime.billing,
    new PayPalHttpProvider(options),
    new PayPalHttpWebhookVerifier(options),
  );
  c.set("paypalService", service);
  return service;
}
