// deno-lint-ignore-file no-explicit-any
import { observeWorkerRequest } from "../../src/cloudflare/observability.ts";
import { createCloudflareApp } from "../../src/cloudflare/runtime.ts";
import type { ExecutionContext } from "../../src/cloudflare/types.ts";

export default {
  fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    return observeWorkerRequest(
      request,
      async () => await createCloudflareApp(env, "ai").fetch(request, env, ctx),
    );
  },
};
