// deno-lint-ignore-file no-explicit-any
import { createSharedHostingRuntime } from "../../src/sharedHostingRuntime.ts";
import { hasSharedNodeRuntimeSettings } from "../../src/productionComposition.ts";
import { createAzureBlobSasSigner } from "../../src/azureBlobSas.ts";
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
import { AllowanceMeter } from "../../src/allowanceMetering.ts";
import { XmclPlusService } from "../../src/xmclPlus.ts";
import { runtimeEnvironmentError } from "../../src/runtimeEnvironment.ts";
import { AlertCooldownObject } from "../../src/cloudflare/alertCooldown.ts";
import { sendRuntimeAlert } from "../../src/cloudflare/runtimeAlerting.ts";

export { DpopReplayObject } from "../../src/cloudflare/dpopReplay.ts";
export { AlertCooldownObject };

function alertProduction(
  env: any,
  alert: Parameters<
    typeof sendRuntimeAlert
  >[0]["alert"],
) {
  return sendRuntimeAlert({
    namespace: env.ALERT_COOLDOWN,
    webhookUrl: env.XMCL_PRODUCTION_DISCORD_ALERT_WEBHOOK_URL,
    environment: "production",
    alert,
  });
}

async function dispatchApiRequest(
  request: Request,
  env: any,
  ctx: ExecutionContext,
) {
  const environmentError = runtimeEnvironmentError(env, "production");
  if (environmentError) {
    ctx.waitUntil(alertProduction(env, {
      severity: "critical",
      event: "api.production.environment_invalid",
      summary: "Production API failed its deployment isolation guard.",
      fields: { reason: environmentError },
    }));
    return Response.json(
      { status: "unavailable", error: environmentError },
      { status: 503 },
    );
  }
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json({ status: "ok", environment: "production" });
  }
  if (request.method === "GET" && url.pathname === "/health/ready") {
    try {
      await getCloudflareDb(env);
      return Response.json({ status: "ready", environment: "production" });
    } catch (error) {
      console.error({
        event: "api.readiness_failed",
        ...workerErrorFields(error),
      });
      ctx.waitUntil(alertProduction(env, {
        severity: "critical",
        event: "api.production.readiness_failed",
        summary: "Production API readiness could not reach its database.",
      }));
      return Response.json({ status: "unavailable" }, { status: 503 });
    }
  }
  if (isRetiredServicePath(request)) {
    return new Response("This API path has been retired", { status: 410 });
  }
  const isWaffoWebhook = request.method === "POST" &&
    url.pathname === "/v1/webhooks/waffo";
  let response: Response;
  try {
    response = await createCloudflareApp(env, "api").fetch(request, env, ctx);
  } catch (error) {
    if (isWaffoWebhook) {
      ctx.waitUntil(alertProduction(env, {
        severity: "critical",
        event: "waffo.production.webhook_failed",
        summary: "A production Waffo webhook failed before reconciliation.",
        fields: { status: 500 },
      }));
    }
    throw error;
  }
  if (isWaffoWebhook && response.status >= 500) {
    ctx.waitUntil(alertProduction(env, {
      severity: "critical",
      event: "waffo.production.webhook_failed",
      summary: "A production Waffo webhook failed before reconciliation.",
      fields: { status: response.status },
    }));
  }
  return response;
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
        let scheduledStage = "environment_guard";
        try {
          const environmentError = runtimeEnvironmentError(env, "production");
          if (environmentError) throw new Error(environmentError);
          if (env.SERVER_CONTROL_SCHEDULED_WORK) {
            scheduledStage = "server_control";
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
          if (
            env.MONGO_CONNECION_STRING &&
            env.XMCL_HOME_RELEASE_ENABLED === "true"
          ) {
            scheduledStage = "ai_settlement";
            const aiResult = await new AllowanceMeter(
              new MongoBillingStore(await getCloudflareDb(env)),
              () => new Date(controller.scheduledTime),
            ).settlePendingAi();
            console.log({
              event: "ai.settlement.completed",
              settledCount: aiResult.settled.length,
              failedCount: aiResult.failed.length,
            });
            if (aiResult.failed.length > 0) {
              console.warn({
                event: "ai.settlement.pending",
                failedCount: aiResult.failed.length,
              });
              await alertProduction(env, {
                severity: "warning",
                event: "ai.production_settlement.pending",
                summary: "Production AI usage settlement remains pending.",
                occurredAt: scheduledAt,
                fields: { failedCount: aiResult.failed.length },
              });
            }
            scheduledStage = "home_renewal";
            const plusResult = await new XmclPlusService(
              new MongoBillingStore(await getCloudflareDb(env)),
              { currency: env.BILLING_CURRENCY ?? "USD" },
            ).renewDue(new Date(controller.scheduledTime));
            console.log({
              event: "xmcl_plus.renewal.completed",
              renewedCount: plusResult.renewed.length,
              paymentDueCount: plusResult.paymentDue.length,
              cancelledCount: plusResult.cancelled.length,
            });
            if (plusResult.paymentDue.length > 0) {
              console.warn({
                event: "xmcl_plus.renewal.payment_due",
                paymentDueCount: plusResult.paymentDue.length,
              });
            }
          }
          const signer = createAzureBlobSasSigner({
            endpoint: env.XMCL_AZURE_BLOB_ENDPOINT,
            container: env.XMCL_AZURE_BLOB_CONTAINER,
            accountName: env.XMCL_AZURE_STORAGE_ACCOUNT_NAME,
            accountKey: env.XMCL_AZURE_STORAGE_ACCOUNT_KEY,
          });
          if (
            hasSharedNodeRuntimeSettings(env, {
              SHARED_NODE_WORKSPACE_SIGNER: signer,
            })
          ) {
            scheduledStage = "shared_hosting";
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
            scheduledStage = "shared_hosting_billing";
            await runSharedHostingBillingScheduledSweep(
              env.SHARED_HOSTING_BILLING_SCHEDULED_WORK,
              scheduledAt,
            );
          } else if (env.SHARED_NODE_SCHEDULED_WORK) {
            scheduledStage = "shared_node";
            await runSharedNodeScheduledSweep(
              env.SHARED_NODE_SCHEDULED_WORK,
              scheduledAt,
            );
          }
          scheduledStage = "reconciliation";
          await env.RECONCILIATION_SCHEDULED_WORK?.run?.();
        } catch (error) {
          console.error({
            event: "worker.scheduled.exception",
            scheduledTime: controller.scheduledTime,
            cron: controller.cron,
            ...workerErrorFields(error),
          });
          await alertProduction(env, {
            severity: "critical",
            event: `worker.production.${scheduledStage}.failed`,
            summary: "A production scheduled task failed.",
            occurredAt: new Date(controller.scheduledTime).toISOString(),
            fields: { stage: scheduledStage },
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
