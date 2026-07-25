import type { AppConfig } from "../src/config.ts";
import type { DbFactory } from "../src/db.ts";
import {
  type BillingReconciliationWork,
  createBillingReconciliationWork,
  createSharedRuntimeSettlementWork,
} from "../src/lib/billingRuntime.ts";
import {
  PayPalHttpProvider,
  PayPalHttpWebhookVerifier,
  PayPalService,
} from "../src/lib/paypal.ts";
import { createS3SigV4Presigner } from "../src/lib/s3SigV4.ts";
import {
  createSharedHostingRuntime,
  type SharedHostingRuntime,
} from "../src/lib/sharedHostingRuntime.ts";
import {
  runSharedNodeScheduledSweep,
} from "../src/lib/sharedNodeScheduling.ts";
import type { SharedNodeWorkspaceSigner } from "../src/lib/sharedNodeTransport.ts";

export const SHARED_HOSTING_HOURLY_TIMER_SCHEDULE = "0 0 * * * *";
export const PAYPAL_RECONCILIATION_LIMIT = 25;

type TimerLogger = {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

export interface AzureSharedHostingHourlyWork {
  run(at: Date): Promise<void>;
}

export interface AzureSharedHostingHourlyWorkFactory {
  create(): Promise<AzureSharedHostingHourlyWork>;
}

export interface AzureSharedHostingTimerDependencies {
  environment: () => AppConfig;
  getDb: DbFactory;
  createSigner: (
    config: AppConfig,
  ) => SharedNodeWorkspaceSigner | undefined;
  createRuntime: (
    db: Awaited<ReturnType<DbFactory>>,
    config: AppConfig,
    signer: SharedNodeWorkspaceSigner,
  ) => SharedHostingRuntime;
  createSettlementWork: typeof createSharedRuntimeSettlementWork;
  runNodeSweep: typeof runSharedNodeScheduledSweep;
}

function hasCompletePayPalSettings(config: AppConfig) {
  return [
    config.PAYPAL_CLIENT_ID,
    config.PAYPAL_CLIENT_SECRET,
    config.PAYPAL_WEBHOOK_ID,
    config.PAYPAL_RETURN_URL,
    config.PAYPAL_CANCEL_URL,
    config.PAYPAL_API_BASE_URL,
  ].every((value) => typeof value === "string" && value.trim().length > 0);
}

function paypalReconciliationWork(
  runtime: SharedHostingRuntime,
  config: AppConfig,
): BillingReconciliationWork | undefined {
  if (!hasCompletePayPalSettings(config)) return undefined;
  const options = {
    clientId: config.PAYPAL_CLIENT_ID!,
    clientSecret: config.PAYPAL_CLIENT_SECRET!,
    webhookId: config.PAYPAL_WEBHOOK_ID!,
    returnUrl: config.PAYPAL_RETURN_URL!,
    cancelUrl: config.PAYPAL_CANCEL_URL!,
    apiBaseUrl: config.PAYPAL_API_BASE_URL!,
  };
  const paypal = new PayPalService(
    runtime.billing,
    new PayPalHttpProvider(options),
    new PayPalHttpWebhookVerifier(options),
  );
  return createBillingReconciliationWork(paypal);
}

function signerFromConfig(config: AppConfig) {
  return createS3SigV4Presigner({
    endpoint: config.XMCL_VULTR_OBJECT_STORAGE_ENDPOINT,
    region: config.XMCL_VULTR_OBJECT_STORAGE_REGION,
    bucket: config.XMCL_VULTR_OBJECT_STORAGE_BUCKET,
    accessKey: config.XMCL_VULTR_OBJECT_STORAGE_ACCESS_KEY,
    secretKey: config.XMCL_VULTR_OBJECT_STORAGE_SECRET_KEY,
  });
}

const defaultDependencies: AzureSharedHostingTimerDependencies = {
  environment: () => process.env as AppConfig,
  getDb: async (config) => {
    const { getDb } = await import("../src/platform/db_npm.ts");
    return await getDb(config);
  },
  createSigner: signerFromConfig,
  createRuntime: createSharedHostingRuntime,
  createSettlementWork: createSharedRuntimeSettlementWork,
  runNodeSweep: runSharedNodeScheduledSweep,
};

/**
 * Creates the durable work fresh for each timer invocation. The database
 * connection is Node-owned, while the runtime and its server-only signer are
 * invocation-scoped composition objects.
 */
export function createAzureSharedHostingHourlyWorkFactory(
  dependencies: AzureSharedHostingTimerDependencies = defaultDependencies,
): AzureSharedHostingHourlyWorkFactory {
  return {
    async create() {
      const config = dependencies.environment();
      const signer = dependencies.createSigner(config);
      if (!signer) {
        throw new Error(
          "shared hosting timer S3 signer settings are incomplete",
        );
      }
      const runtime = dependencies.createRuntime(
        await dependencies.getDb(config),
        config,
        signer,
      );
      const reconciliation = paypalReconciliationWork(runtime, config);
      const settlement = dependencies.createSettlementWork(
        runtime,
        runtime.scheduler,
        reconciliation,
      );
      return {
        async run(at: Date) {
          await settlement.runHourly(at, PAYPAL_RECONCILIATION_LIMIT);
          await runtime.scheduler.processCapacityRequests();
          await dependencies.runNodeSweep(runtime.transport, at.toISOString());
        },
      };
    },
  };
}

function failureContext(at: Date) {
  return {
    event: "shared_hosting_hourly_failed",
    invokedAt: at.toISOString(),
    error: "scheduler_failure",
  };
}

/**
 * Logs only cadence/error-class metadata and rethrows so Azure Functions and
 * Application Insights record the invocation failure.
 */
export function createAzureSharedHostingHourlyTimerHandler(
  workFactory: AzureSharedHostingHourlyWorkFactory,
  now: () => Date = () => new Date(),
) {
  return async (_timer: unknown, context: TimerLogger) => {
    const at = now();
    try {
      await (await workFactory.create()).run(at);
      context.log("shared_hosting_hourly_completed", {
        event: "shared_hosting_hourly_completed",
        invokedAt: at.toISOString(),
      });
    } catch (error) {
      context.error("shared_hosting_hourly_failed", failureContext(at));
      throw error;
    }
  };
}
