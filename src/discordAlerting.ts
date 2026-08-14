export type AlertSeverity = "critical" | "warning";

export interface DiscordAlert {
  environment: "staging" | "production";
  severity: AlertSeverity;
  event: string;
  summary: string;
  occurredAt: string;
  fields?: Record<string, string | number | boolean>;
}

const DISCORD_REQUEST_TIMEOUT_MS = 10_000;

export async function sendDiscordAlert(
  webhookUrl: string,
  alert: DiscordAlert,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const url = new URL(webhookUrl);
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "discord.com" && url.hostname !== "discordapp.com") ||
    !/^\/api\/webhooks\/\d+\/[^/]+$/.test(url.pathname)
  ) {
    throw new Error("Invalid Discord webhook URL");
  }
  const response = await fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "XMCL Together Alerts",
      allowed_mentions: { parse: [] },
      embeds: [{
        title: `[${alert.severity.toUpperCase()}] ${safeText(alert.event, 200)}`,
        description: safeText(alert.summary, 1_000),
        color: alert.severity === "critical" ? 0xdc2626 : 0xf59e0b,
        fields: Object.entries(alert.fields ?? {}).slice(0, 10).map(
          ([name, value]) => ({
            name: safeText(name, 256),
            value: safeText(String(value), 1_024),
            inline: true,
          }),
        ),
        footer: { text: `environment=${alert.environment}` },
        timestamp: alert.occurredAt,
      }],
    }),
    signal: AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Discord webhook returned ${response.status}`);
  }
}

function safeText(value: string, maximumLength: number) {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, maximumLength);
}
