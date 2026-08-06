// deno-lint-ignore-file no-explicit-any
import { observeWorkerRequest } from "../../packages/shared/platform/cloudflare/observability.ts";
import { createCloudflareApp } from "../../packages/shared/platform/cloudflare/runtime.ts";
import type { ExecutionContext } from "../../packages/shared/platform/cloudflare/types.ts";

export default {
  fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    return observeWorkerRequest(
      request,
      async () => await createCloudflareApp(env, "ai").fetch(request, env, ctx),
    );
  },
};
