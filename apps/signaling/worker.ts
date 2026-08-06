// deno-lint-ignore-file no-explicit-any
import { observeWorkerRequest } from "../../packages/shared/platform/cloudflare/observability.ts";
import { createCloudflareApp } from "../../packages/shared/platform/cloudflare/runtime.ts";
import type { ExecutionContext } from "../../packages/shared/platform/cloudflare/types.ts";
import { matchMultiplayerUpgrade } from "../../packages/shared/realtime/match.ts";

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
};
