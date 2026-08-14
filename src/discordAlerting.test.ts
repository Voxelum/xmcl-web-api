import assert from "node:assert/strict";
import { sendDiscordAlert } from "./discordAlerting.ts";

Deno.test("Discord alerts use bounded embeds without mentions", async () => {
  let request: Request | undefined;
  await sendDiscordAlert(
    "https://discord.com/api/webhooks/123456789/test-token",
    {
      environment: "staging",
      severity: "critical",
      event: "turn.staging_metering.failed",
      summary: "TURN analytics settlement failed",
      occurredAt: "2026-08-14T15:00:00.000Z",
      fields: {
        errorName: "ProviderUnavailable",
        scheduledAt: "2026-08-14T15:00:00.000Z",
      },
    },
    async (input, init) => {
      request = new Request(input, init);
      return new Response(null, { status: 204 });
    },
  );

  const payload = await request!.json();
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.equal(payload.embeds[0].title, "[CRITICAL] turn.staging_metering.failed");
  assert.equal(payload.embeds[0].footer.text, "environment=staging");
  assert.doesNotMatch(JSON.stringify(payload), /@everyone|test-token/);
});

Deno.test("Discord alerts reject non-Discord webhook destinations", async () => {
  await assert.rejects(
    () =>
      sendDiscordAlert("https://example.com/api/webhooks/1/token", {
        environment: "staging",
        severity: "warning",
        event: "test",
        summary: "test",
        occurredAt: "2026-08-14T15:00:00.000Z",
      }),
    /Invalid Discord webhook URL/,
  );
});
