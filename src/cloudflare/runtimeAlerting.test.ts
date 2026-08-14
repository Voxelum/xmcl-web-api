import assert from "node:assert/strict";
import { sendRuntimeAlert } from "./runtimeAlerting.ts";
import type { DurableObjectNamespace } from "./types.ts";

Deno.test("runtime alerts retain their cooldown after delivery failure", async () => {
  let claims = 0;
  let deliveries = 0;
  const namespace = {
    idFromName: () => ({}),
    get: () => ({
      fetch: () => {
        claims += 1;
        return Promise.resolve(Response.json({ claimed: claims === 1 }));
      },
    }),
  } as unknown as DurableObjectNamespace;
  const input = {
    namespace,
    webhookUrl: "https://discord.com/api/webhooks/123/token",
    fetcher: () => {
      deliveries += 1;
      return Promise.resolve(new Response("failed", { status: 503 }));
    },
    environment: "production" as const,
    alert: {
      severity: "critical" as const,
      event: "ai.production.request_failed",
      summary: "Production AI request failed.",
    },
  };

  await sendRuntimeAlert(input);
  await sendRuntimeAlert(input);

  assert.equal(claims, 2);
  assert.equal(deliveries, 1);
});
