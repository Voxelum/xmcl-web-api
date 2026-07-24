import type { SharedHostingService } from "./sharedHosting.ts";
import type { SharedHostingScheduler } from "./sharedHostingScheduler.ts";

export interface SharedHostingBillingSweepResult {
  renewed: string[];
  paymentDue: string[];
  cancelled: string[];
  runtimeSettled?: string[];
  runtimePaymentDue?: string[];
}

export interface SharedHostingBillingScheduledWork {
  renewDue(at: Date): Promise<SharedHostingBillingSweepResult>;
}

export class SharedHostingBillingSchedulingConfigurationError extends Error {
  constructor() {
    super(
      "SHARED_HOSTING_BILLING_SCHEDULED_WORK must provide renewDue(at)",
    );
  }
}

/**
 * Runs the trusted UTC scheduler operation. `renewDue` is intentionally
 * idempotent, so a daily midnight tick can safely recover missed invocations
 * and process every calendar-month boundary that has elapsed.
 */
export async function runSharedHostingBillingScheduledSweep(
  work: SharedHostingBillingScheduledWork | undefined,
  at: string,
): Promise<SharedHostingBillingSweepResult> {
  if (!work || typeof work.renewDue !== "function") {
    throw new SharedHostingBillingSchedulingConfigurationError();
  }
  const parsed = new Date(at);
  if (!Number.isFinite(parsed.getTime())) {
    throw new SharedHostingBillingSchedulingConfigurationError();
  }
  return await work.renewDue(parsed);
}

export function sharedHostingBillingWork(
  service: SharedHostingService,
  scheduler?: SharedHostingScheduler,
): SharedHostingBillingScheduledWork {
  return {
    renewDue: async (at) => {
      const renewal = await service.renewDue(at);
      if (scheduler) await scheduler.enforcePaymentDue(renewal.paymentDue);
      const runtime = scheduler
        ? await scheduler.settleRunningRuntime(at)
        : undefined;
      return {
        ...renewal,
        runtimeSettled: runtime?.settled,
        runtimePaymentDue: runtime?.paymentDue,
      };
    },
  };
}
