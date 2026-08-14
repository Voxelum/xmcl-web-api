// deno-lint-ignore-file no-explicit-any
import { observeWorkerRequest } from "../../src/cloudflare/observability.ts";
import { createCloudflareApp } from "../../src/cloudflare/runtime.ts";
import type { ExecutionContext } from "../../src/cloudflare/types.ts";
import { sendRuntimeAlert } from "../../src/cloudflare/runtimeAlerting.ts";

export default {
  fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    return observeWorkerRequest(
      request,
      async () => {
        let response: Response;
        try {
          response = await createCloudflareApp(env, "ai").fetch(
            request,
            env,
            ctx,
          );
        } catch (error) {
          ctx.waitUntil(sendRuntimeAlert({
            namespace: env.ALERT_COOLDOWN,
            webhookUrl: env.XMCL_PRODUCTION_DISCORD_ALERT_WEBHOOK_URL,
            environment: "production",
            alert: {
              severity: "critical",
              event: "ai.production.request_failed",
              summary: "A production AI request failed unexpectedly.",
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
              event: "ai.production.request_failed",
              summary: "A production AI request returned a server error.",
              fields: { status: response.status },
            },
          }));
        }
        return response;
      },
    );
  },
};
