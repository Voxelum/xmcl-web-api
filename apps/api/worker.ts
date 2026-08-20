// deno-lint-ignore-file no-explicit-any
import { createSharedHostingRuntime } from "../../src/sharedHostingRuntime.ts";
import { hasSharedNodeRuntimeSettings } from "../../src/productionComposition.ts";
import { createS3SigV4Presigner } from "../../src/s3SigV4.ts";
import { runServerControlScheduledSweep } from "../../src/serverControlScheduling.ts";
import { runSharedHostingBillingScheduledSweep } from "../../src/sharedHostingScheduling.ts";
import { runSharedNodeScheduledSweep } from "../../src/sharedNodeScheduling.ts";
import { getTranslationEdgeCache } from "../../src/translationEdgeCache.ts";
import { runTranslationScheduledSweep } from "../../src/translationScheduling.ts";
import { getTranslationStore } from "../../src/translationStore.ts";
import {
  createCloudflareApp,
  getCloudflareDb,
} from "../../src/cloudflare/runtime.ts";
import {
  observeWorkerRequest,
  workerErrorFields,
} from "../../src/cloudflare/observability.ts";
import type {
  ExecutionContext,
  ScheduledController,
} from "../../src/cloudflare/types.ts";
import { isRetiredServicePath } from "../../src/realtime.ts";
import { MongoBillingStore } from "../../src/ledger.ts";
import { XmclPlusService } from "../../src/xmclPlus.ts";

export { AlertCooldownObject } from "../../src/cloudflare/alertCooldown.ts";
export { DpopReplayObject } from "../../src/cloudflare/dpopReplay.ts";

async function dispatchApiRequest(
  request: Request,
  env: any,
  ctx: ExecutionContext,
) {
  if (isRetiredServicePath(request)) {
    return new Response("This API path has been retired", { status: 410 });
  }
  return createCloudflareApp(env, "api").fetch(request, env, ctx);
}

export default {
  async fetch(
    request: Request,
    env: any,
    ctx: ExecutionContext,
  ): Promise<Response> {
    return observeWorkerRequest(
      request,
      () => dispatchApiRequest(request, env, ctx),
    );
  },

  queue(
    batch: {
      queue: string;
      messages: Array<{ id: string; ack(): void }>;
    },
    _env: any,
    _ctx: ExecutionContext,
  ): void {
    console.warn({
      event: "legacy_translation_queue.drained",
      queue: batch.queue,
      messageCount: batch.messages.length,
    });
    for (const message of batch.messages) {
      message.ack();
    }
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
          if (
            env.AZURE_TRANSLATION_TABLE_URL &&
            env.AGNES_API_KEYS
          ) {
            try {
              const translationStore = getTranslationStore(env);
              if (!translationStore) {
                throw new Error("Translation store is not configured");
              }
              const translationResult = await runTranslationScheduledSweep(
                translationStore,
                env,
                {
                  now: new Date(controller.scheduledTime),
                  edgeCache: getTranslationEdgeCache(
                    env.TRANSLATION_CACHE,
                  ),
                },
              );
              console.log({
                event: "translation.scheduled.completed",
                ...translationResult,
              });
            } catch (error) {
              console.error({
                event: "translation.scheduled.failed",
                ...workerErrorFields(error),
              });
            }
          }
          const scheduledAt = new Date(controller.scheduledTime).toISOString();
          if (env.MONGO_CONNECION_STRING) {
            const plusResult = await new XmclPlusService(
              new MongoBillingStore(await getCloudflareDb(env)),
              { currency: env.BILLING_CURRENCY ?? "USD" },
            ).renewDue(new Date(controller.scheduledTime));
            console.log({
              event: "xmcl_plus.renewal.completed",
              ...plusResult,
            });
          }
          const signer = createS3SigV4Presigner({
            endpoint: env.XMCL_VULTR_OBJECT_STORAGE_ENDPOINT,
            region: env.XMCL_VULTR_OBJECT_STORAGE_REGION,
            bucket: env.XMCL_VULTR_OBJECT_STORAGE_BUCKET,
            accessKey: env.XMCL_VULTR_OBJECT_STORAGE_ACCESS_KEY,
            secretKey: env.XMCL_VULTR_OBJECT_STORAGE_SECRET_KEY,
          });
          if (
            hasSharedNodeRuntimeSettings(env, {
              SHARED_NODE_WORKSPACE_SIGNER: signer,
            })
          ) {
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
        } catch (error) {
          console.error({
            event: "worker.scheduled.exception",
            scheduledTime: controller.scheduledTime,
            cron: controller.cron,
            ...workerErrorFields(error),
          });
          const observed = new Error(
            `Scheduled Worker task failed; scheduledTime=${controller.scheduledTime}`,
          );
          observed.name = "ObservedScheduledWorkerError";
          throw observed;
        }
      })(),
    );
  },
};
