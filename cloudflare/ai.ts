// deno-lint-ignore-file no-explicit-any
import type { ExecutionContext } from "./cf_types.ts";
import { observeWorkerRequest } from "./observability.ts";
import { createCloudflareApp } from "./runtime.ts";

export default {
  fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    return observeWorkerRequest(
      request,
      async () => await createCloudflareApp(env, "ai").fetch(request, env, ctx),
    );
  },
};
