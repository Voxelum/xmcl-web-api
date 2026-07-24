// deno-lint-ignore-file no-explicit-any
import { createMiddleware } from "hono/factory";
import type { AppConfig } from "../src/config.ts";
import { createProductionApp } from "../src/lib/productionComposition.ts";
import { createDbMiddleware } from "../src/middleware/db.ts";
import { matchGroupUpgrade } from "../src/realtime/match.ts";
import { runServerControlScheduledSweep } from "../src/lib/serverControlScheduling.ts";
import { runSharedHostingBillingScheduledSweep } from "../src/lib/sharedHostingScheduling.ts";
import { runSharedNodeScheduledSweep } from "../src/lib/sharedNodeScheduling.ts";
import {
  createSharedHostingRuntime,
} from "../src/lib/sharedHostingRuntime.ts";
import { hasSharedNodeRuntimeSettings } from "../src/lib/productionComposition.ts";
import { createS3SigV4Presigner } from "../src/lib/s3SigV4.ts";
import type { AppEnv } from "../src/types.ts";
import type { DbFactory } from "../src/db.ts";
import type { ExecutionContext, ScheduledController } from "./cf_types.ts";
import { GroupRoom } from "./group_room.ts";

// The Durable Object class must be exported from the worker module.
export { GroupRoom };

// bson initializes secure randomness at module evaluation time, which Cloudflare
// rejects in Worker global scope. Loading the Mongo connector on first database
// use keeps the Worker module side-effect free.
const getCloudflareDb: DbFactory = async (config) => {
  const { createDb } = await import("../src/platform/db_npm.ts");
  return createDb(config);
};

/**
 * Cloudflare Workers entry point. Reuses the shared Hono app and injects the
 * Cloudflare-specific platform behaviour:
 *  - `/group/:id` realtime upgrades are forwarded to the GroupRoom Durable
 *    Object (intercepted before the app so CORS never touches the 101 response).
 *  - `/translation` records cache misses in Mongo for an external batch worker.
 *  - geo is resolved natively via `request.cf.country` (see src/geo.ts).
 */
const platformMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const env = c.env as any;
  if (env.ADMIN_OPERATION_AUTHENTICATOR) {
    c.set("adminOperationAuthenticator", env.ADMIN_OPERATION_AUTHENTICATOR);
  }
  if (env.ADMIN_OPERATION_REPOSITORY) {
    c.set("adminOperationRepository", env.ADMIN_OPERATION_REPOSITORY);
  }
  if (env.ADMIN_OPERATION_AUDIT_LOG) {
    c.set("adminOperationAuditLog", env.ADMIN_OPERATION_AUDIT_LOG);
  }
  if (env.BILLING_ADMIN_OPERATION_ADAPTER) {
    c.set(
      "billingAdminOperationAdapter",
      env.BILLING_ADMIN_OPERATION_ADAPTER,
    );
  }
  if (env.SERVER_CONTROL_ADMIN_OPERATION_ADAPTER) {
    c.set(
      "serverControlAdminOperationAdapter",
      env.SERVER_CONTROL_ADMIN_OPERATION_ADAPTER,
    );
  }
  if (env.ADMIN_OPERATION_AUDIT_EVENTS) {
    c.set("adminOperationAuditEvents", env.ADMIN_OPERATION_AUDIT_EVENTS);
  }
  if (env.ADMIN_OPERATION_METRICS) {
    c.set("adminOperationMetrics", env.ADMIN_OPERATION_METRICS);
  }
  if (env.ADMIN_OPERATION_RECONCILIATION) {
    c.set(
      "adminOperationReconciliation",
      env.ADMIN_OPERATION_RECONCILIATION,
    );
  }
  if (env.ADMIN_OPERATION_ACCOUNT_READER) {
    c.set("adminOperationAccountReader", env.ADMIN_OPERATION_ACCOUNT_READER);
  }
  await next();
});

function createCloudflareApp(
  env: AppConfig,
) {
  const signer = createS3SigV4Presigner({
    endpoint: env.XMCL_VULTR_OBJECT_STORAGE_ENDPOINT,
    region: env.XMCL_VULTR_OBJECT_STORAGE_REGION,
    bucket: env.XMCL_VULTR_OBJECT_STORAGE_BUCKET,
    accessKey: env.XMCL_VULTR_OBJECT_STORAGE_ACCESS_KEY,
    secretKey: env.XMCL_VULTR_OBJECT_STORAGE_SECRET_KEY,
  });
  return createProductionApp((a) => {
    a.use("*", createDbMiddleware(getCloudflareDb));
    a.use("*", platformMiddleware);
  }, env, { SHARED_NODE_WORKSPACE_SIGNER: signer });
}

export default {
  fetch(
    request: Request,
    env: any,
    ctx: ExecutionContext,
  ): Response | Promise<Response> {
    const group = matchGroupUpgrade(request);
    if (group !== undefined) {
      const ns = env.GROUP_ROOM;
      const stub = ns.get(ns.idFromName(group));
      return stub.fetch(request);
    }
    return createCloudflareApp(env).fetch(request, env, ctx);
  },

  scheduled(
    controller: ScheduledController,
    env: any,
    ctx: ExecutionContext,
  ): void {
    ctx.waitUntil(
      (async () => {
        try {
          if (env.SERVER_CONTROL_SCHEDULED_WORK) {
            await runServerControlScheduledSweep(
              env.SERVER_CONTROL_SCHEDULED_WORK,
              new Date(controller.scheduledTime).toISOString(),
            );
          }
          const scheduledAt = new Date(controller.scheduledTime).toISOString();
          const signer = createS3SigV4Presigner({
            endpoint: env.XMCL_VULTR_OBJECT_STORAGE_ENDPOINT,
            region: env.XMCL_VULTR_OBJECT_STORAGE_REGION,
            bucket: env.XMCL_VULTR_OBJECT_STORAGE_BUCKET,
            accessKey: env.XMCL_VULTR_OBJECT_STORAGE_ACCESS_KEY,
            secretKey: env.XMCL_VULTR_OBJECT_STORAGE_SECRET_KEY,
          });
          if (hasSharedNodeRuntimeSettings(env, {
            SHARED_NODE_WORKSPACE_SIGNER: signer,
          })) {
            const runtime = createSharedHostingRuntime(
              await getCloudflareDb(env),
              env,
              signer,
            );
            await runSharedHostingBillingScheduledSweep(
              runtime.billingScheduledWork,
              scheduledAt,
            );
            await runtime.scheduler.processCapacityRequests();
            await runSharedNodeScheduledSweep(
              runtime.transport,
              scheduledAt,
            );
          } else if (env.SHARED_HOSTING_BILLING_SCHEDULED_WORK) {
            await runSharedHostingBillingScheduledSweep(
              env.SHARED_HOSTING_BILLING_SCHEDULED_WORK,
              scheduledAt,
            );
          } else if (env.SHARED_NODE_SCHEDULED_WORK) {
            await runSharedNodeScheduledSweep(
              env.SHARED_NODE_SCHEDULED_WORK,
              scheduledAt,
            );
          }
          await env.RECONCILIATION_SCHEDULED_WORK?.run?.();
        } catch (e) {
          console.error(e);
        }
      })(),
    );
  },
};
