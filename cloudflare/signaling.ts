// deno-lint-ignore-file no-explicit-any
import { matchMultiplayerUpgrade } from "../src/realtime/match.ts";
import type { ExecutionContext } from "./cf_types.ts";
import { observeWorkerRequest } from "./observability.ts";
import { createCloudflareApp } from "./runtime.ts";

export { MultiplayerRoomObject } from "./multiplayer_room.ts";

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
