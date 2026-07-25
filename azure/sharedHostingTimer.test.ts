import assert from "node:assert/strict";
import type { AppConfig } from "../src/config.ts";
import type { Db } from "../src/db.ts";
import type { SharedHostingRuntime } from "../src/lib/sharedHostingRuntime.ts";
import {
  type AzureSharedHostingHourlyWorkFactory,
  type AzureSharedHostingTimerDependencies,
  createAzureSharedHostingHourlyTimerHandler,
  createAzureSharedHostingHourlyWorkFactory,
  PAYPAL_RECONCILIATION_LIMIT,
} from "./sharedHostingTimer.ts";

const at = new Date("2026-07-25T08:00:00.000Z");
const db = { collection: () => ({}) } as unknown as Db;
const signer = {
  presign: async () => ({
    key: "shared-hosting/test",
    method: "GET" as const,
    url: "https://storage.example/grant",
    expiresAt: at.toISOString(),
  }),
};

function runtime(calls: string[]): SharedHostingRuntime {
  return {
    billing: {} as SharedHostingRuntime["billing"],
    sharedHosting: {} as SharedHostingRuntime["sharedHosting"],
    scheduler: {
      processCapacityRequests: async () => {
        calls.push("capacity");
        return 1;
      },
    } as SharedHostingRuntime["scheduler"],
    transport: {} as SharedHostingRuntime["transport"],
    provisioner: {} as SharedHostingRuntime["provisioner"],
    billingScheduledWork: {
      renewDue: async () => ({
        renewed: [],
        paymentDue: [],
        cancelled: [],
      }),
    },
  };
}

function dependencies(
  config: AppConfig,
  calls: string[],
  reconciliation: { value?: boolean },
): AzureSharedHostingTimerDependencies {
  return {
    environment: () => config,
    getDb: async () => db,
    createSigner: () => signer,
    createRuntime: () => runtime(calls),
    createSettlementWork: (_runtime, _scheduler, paypal) => {
      reconciliation.value = paypal !== undefined;
      return {
        renewDue: async () => ({
          renewed: [],
          paymentDue: [],
          cancelled: [],
          runtimeSettled: [],
          runtimePaymentDue: [],
          paypalReconciliation: {
            attempted: [],
            finalized: [],
            stillPending: [],
            failed: [],
          },
        }),
        runHourly: async (receivedAt, limit) => {
          calls.push(`settlement:${receivedAt.toISOString()}:${limit}`);
          return {
            renewed: [],
            paymentDue: [],
            cancelled: [],
            runtimeSettled: [],
            runtimePaymentDue: [],
            paypalReconciliation: {
              attempted: [],
              finalized: [],
              stillPending: [],
              failed: [],
            },
          };
        },
      };
    },
    runNodeSweep: async (_work, scheduledAt) => {
      calls.push(`node:${scheduledAt}`);
      return { redelivered: 0 };
    },
  };
}

Deno.test("Azure shared-hosting hourly work settles before capacity and node sweeps", async () => {
  const calls: string[] = [];
  const reconciliation: { value?: boolean } = {};
  const work = await createAzureSharedHostingHourlyWorkFactory(
    dependencies({}, calls, reconciliation),
  ).create();

  await work.run(at);

  assert.deepEqual(calls, [
    `settlement:${at.toISOString()}:${PAYPAL_RECONCILIATION_LIMIT}`,
    "capacity",
    `node:${at.toISOString()}`,
  ]);
  assert.equal(reconciliation.value, false);
});

Deno.test("Azure shared-hosting hourly work composes PayPal recovery only with complete settings", async () => {
  const calls: string[] = [];
  const reconciliation: { value?: boolean } = {};
  const work = await createAzureSharedHostingHourlyWorkFactory(
    dependencies(
      {
        PAYPAL_CLIENT_ID: "client",
        PAYPAL_CLIENT_SECRET: "secret",
        PAYPAL_WEBHOOK_ID: "webhook",
        PAYPAL_RETURN_URL: "https://control.example/return",
        PAYPAL_CANCEL_URL: "https://control.example/cancel",
        PAYPAL_API_BASE_URL: "https://api-m.sandbox.paypal.com",
      },
      calls,
      reconciliation,
    ),
  ).create();

  await work.run(at);

  assert.equal(reconciliation.value, true);
});

Deno.test("Azure shared-hosting timer logs sanitized failure context and propagates", async () => {
  const errors: unknown[][] = [];
  const factory: AzureSharedHostingHourlyWorkFactory = {
    create: async () => ({
      run: async () => {
        throw new Error("provider response with secret");
      },
    }),
  };
  const handler = createAzureSharedHostingHourlyTimerHandler(factory, () => at);

  await assert.rejects(
    () => handler({}, { log: () => {}, error: (...args) => errors.push(args) }),
    /provider response with secret/,
  );

  assert.deepEqual(errors, [[
    "shared_hosting_hourly_failed",
    {
      event: "shared_hosting_hourly_failed",
      invokedAt: at.toISOString(),
      error: "scheduler_failure",
    },
  ]]);
});
