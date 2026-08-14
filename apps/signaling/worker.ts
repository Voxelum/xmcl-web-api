// deno-lint-ignore-file no-explicit-any
import { observeWorkerRequest } from "../../src/cloudflare/observability.ts";
import {
  createCloudflareApp,
  getCloudflareDb,
} from "../../src/cloudflare/runtime.ts";
import type {
  ExecutionContext,
  ScheduledController,
} from "../../src/cloudflare/types.ts";
import { MongoBillingStore } from "../../src/ledger.ts";
import { matchMultiplayerUpgrade } from "../../src/realtime.ts";
import {
  runTurnMeteringSweep,
  TurnCredentialMeter,
} from "../../src/turnMetering.ts";
import { sendRuntimeAlert } from "../../src/cloudflare/runtimeAlerting.ts";

export { MultiplayerRoomObject } from "./room.ts";

async function dispatchSignalingRequest(
  request: Request,
  env: any,
  ctx: ExecutionContext,
) {
  const roomId = matchMultiplayerUpgrade(request);
  if (roomId !== undefined) {
    const internalUrl = new URL(request.url);
    internalUrl.pathname = "/connect";
    return env.MULTIPLAYER_ROOMS.get(
      env.MULTIPLAYER_ROOMS.idFromName(roomId),
    ).fetch(new Request(internalUrl, request));
  }
  return createCloudflareApp(env, "signaling").fetch(request, env, ctx);
}

export default {
  fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    return observeWorkerRequest(
      request,
      async () => {
        let response: Response;
        try {
          response = await dispatchSignalingRequest(request, env, ctx);
        } catch (error) {
          ctx.waitUntil(sendRuntimeAlert({
            namespace: env.ALERT_COOLDOWN,
            webhookUrl: env.XMCL_PRODUCTION_DISCORD_ALERT_WEBHOOK_URL,
            environment: "production",
            alert: {
              severity: "critical",
              event: "signaling.production.request_failed",
              summary: "A production signaling request failed unexpectedly.",
              fields: { status: 500 },
            },
          }));
          throw error;
        }
        if (response.status >= 500) {
          ctx.waitUntil(sendRuntimeAlert({
            namespace: env.ALERT_COOLDOWN,
            webhookUrl: env.XMCL_PRODUCTION_DISCORD_ALERT_WEBHOOK_URL,
            environment: "production",
            alert: {
              severity: "critical",
              event: "signaling.production.request_failed",
              summary: "A production signaling request returned a server error.",
              fields: { status: response.status },
            },
          }));
        }
        return response;
      },
    );
  },
  scheduled(
    controller: ScheduledController,
    env: any,
    ctx: ExecutionContext,
  ): void {
    ctx.waitUntil((async () => {
      if (
        !env.CLOUDFLARE_ACCOUNT_ID ||
        !(env.CLOUDFLARE_TURN_ANALYTICS_API_TOKEN ??
          env.CLOUDFLARE_ANALYTICS_API_TOKEN)
      ) {
        console.warn({ event: "turn.metering.not_configured" });
        await sendRuntimeAlert({
          namespace: env.ALERT_COOLDOWN,
          webhookUrl: env.XMCL_PRODUCTION_DISCORD_ALERT_WEBHOOK_URL,
          environment: "production",
          alert: {
            severity: "critical",
            event: "turn.production_metering.not_configured",
            summary: "Production TURN metering configuration is incomplete.",
            occurredAt: new Date(controller.scheduledTime).toISOString(),
          },
        });
        return;
      }
      const db = await getCloudflareDb(env);
      const result = await runTurnMeteringSweep(
        new TurnCredentialMeter(new MongoBillingStore(db)),
        {
          accountId: env.CLOUDFLARE_ACCOUNT_ID,
          apiToken: env.CLOUDFLARE_TURN_ANALYTICS_API_TOKEN ??
            env.CLOUDFLARE_ANALYTICS_API_TOKEN,
        },
        new Date(controller.scheduledTime),
      );
      console.log({ event: "turn.metering.completed", ...result });
    })().catch((error) => {
      console.error({
        event: "turn.metering.failed",
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      return sendRuntimeAlert({
        namespace: env.ALERT_COOLDOWN,
        webhookUrl: env.XMCL_PRODUCTION_DISCORD_ALERT_WEBHOOK_URL,
        environment: "production",
        alert: {
          severity: "critical",
          event: "turn.production_metering.failed",
          summary: "The production TURN metering sweep failed.",
          occurredAt: new Date(controller.scheduledTime).toISOString(),
        },
      }).then(() => {
        throw error;
      });
    }));
  },
};
