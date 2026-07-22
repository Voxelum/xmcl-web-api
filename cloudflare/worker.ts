// deno-lint-ignore-file no-explicit-any
import { createMiddleware } from "hono/factory";
import type { AppConfig } from "../src/config.ts";
import {
  createProductionApp,
  productionAppOptions,
} from "../src/lib/productionComposition.ts";
import { createDbMiddleware } from "../src/middleware/db.ts";
import { getDb } from "../src/platform/db_npm.ts";
import { matchGroupUpgrade } from "../src/realtime/match.ts";
import { runServerControlScheduledSweep } from "../src/lib/serverControlScheduling.ts";
import {
  runTranslation,
  type TranslationJob,
} from "../src/translation_service.ts";
import type { AppEnv } from "../src/types.ts";
import type {
  ExecutionContext,
  MessageBatch,
  ScheduledController,
} from "./cf_types.ts";
import { GroupRoom } from "./group_room.ts";

// The Durable Object class must be exported from the worker module.
export { GroupRoom };

/**
 * Cloudflare Workers entry point. Reuses the shared Hono app and injects the
 * Cloudflare-specific platform behaviour:
 *  - `/group/:id` realtime upgrades are forwarded to the GroupRoom Durable
 *    Object (intercepted before the app so CORS never touches the 101 response).
 *  - `/translation` offloads work to a Queue; the `queue` handler processes it.
 *  - geo is resolved natively via `request.cf.country` (see src/geo.ts).
 */
const platformMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const env = c.env as any;
  if (env.TRANSLATION_QUEUE) {
    c.set("enqueueTranslation", async (job: TranslationJob) => {
      try {
        await env.TRANSLATION_QUEUE.send(job);
        return true;
      } catch (e) {
        console.error("Failed to enqueue translation", e);
        return false;
      }
    });
  }
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

function createCloudflareApp(env: AppConfig) {
  return createProductionApp(env, (a) => {
    a.use("*", createDbMiddleware(getDb));
    a.use("*", platformMiddleware);
  });
}

async function processJob(env: any, job: TranslationJob): Promise<void> {
  const config = env as AppConfig;
  const kv = env.TRANSLATION_KV;
  const semaphoreKey = `translate:${job.lang}:${job.id}`;

  if (kv) {
    const existing = await kv.get(semaphoreKey);
    if (existing) return;
    await kv.put(semaphoreKey, "1", { expirationTtl: 600 });
  }

  try {
    const db = await getDb(config);
    const coll = db.collection(`${job.lang}_translation`);
    const found = await coll.findOne({ _id: { $eq: job.id } });
    if (found && found.bodyHash === job.bodyHash) return;

    const result = await runTranslation(db, job, {
      agnes: config.AGNES_API_KEY,
    });
    if (typeof result === "object") {
      console.error("Failed to translate", result.error);
    }
  } finally {
    if (kv) await kv.delete(semaphoreKey).catch(() => {});
  }
}

export default {
  fetch(
    request: Request,
    env: any,
    ctx: ExecutionContext,
  ): Response | Promise<Response> {
    productionAppOptions(env);
    const group = matchGroupUpgrade(request);
    if (group !== undefined) {
      const ns = env.GROUP_ROOM;
      const stub = ns.get(ns.idFromName(group));
      return stub.fetch(request);
    }
    return createCloudflareApp(env).fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<TranslationJob>, env: any): Promise<void> {
    productionAppOptions(env);
    for (const message of batch.messages) {
      try {
        await processJob(env, message.body);
        message.ack();
      } catch (e) {
        console.error("Translation job failed", e);
        message.retry();
      }
    }
  },

  scheduled(
    controller: ScheduledController,
    env: any,
    ctx: ExecutionContext,
  ): void {
    // Validate deployment configuration before scheduling durable commercial work.
    productionAppOptions(env);
    ctx.waitUntil(
      (async () => {
        try {
          if (env.SERVER_CONTROL_SCHEDULED_WORK) {
            await runServerControlScheduledSweep(
              env.SERVER_CONTROL_SCHEDULED_WORK,
              new Date(controller.scheduledTime).toISOString(),
            );
          }
          await env.RECONCILIATION_SCHEDULED_WORK?.run?.();
          if (env.TRANSLATION_KV) {
            await env.TRANSLATION_KV.put("last-cron", new Date().toISOString());
          }
        } catch (e) {
          console.error(e);
        }
      })(),
    );
  },
};
