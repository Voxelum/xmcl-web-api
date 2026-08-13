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
      () => dispatchSignalingRequest(request, env, ctx),
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
        !env.CLOUDFLARE_ANALYTICS_API_TOKEN
      ) {
        console.warn({ event: "turn.metering.not_configured" });
        return;
      }
      const db = await getCloudflareDb(env);
      const result = await runTurnMeteringSweep(
        new TurnCredentialMeter(new MongoBillingStore(db)),
        {
          accountId: env.CLOUDFLARE_ACCOUNT_ID,
          apiToken: env.CLOUDFLARE_ANALYTICS_API_TOKEN,
        },
        new Date(controller.scheduledTime),
      );
      console.log({ event: "turn.metering.completed", ...result });
    })().catch((error) => {
      console.error({
        event: "turn.metering.failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }));
  },
};
