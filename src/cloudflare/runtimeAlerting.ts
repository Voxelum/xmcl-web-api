import {
  type DiscordAlert,
  sendDiscordAlert,
} from "../discordAlerting.ts";
import {
  claimAlertCooldown,
} from "./alertCooldown.ts";
import type { DurableObjectNamespace } from "./types.ts";

const ALERT_COOLDOWN_MS = 15 * 60_000;

export async function sendRuntimeAlert(input: {
  namespace?: DurableObjectNamespace;
  webhookUrl?: string;
  fetcher?: typeof fetch;
  environment: "staging" | "production";
  alert: Omit<DiscordAlert, "environment" | "occurredAt"> & {
    occurredAt?: string;
  };
}) {
  if (!input.webhookUrl) return;
  if (!input.namespace) {
    console.error({
      event: "alert.cooldown_not_configured",
      alertEvent: input.alert.event,
    });
    return;
  }
  const now = Date.now();
  let claimed: boolean;
  try {
    claimed = await claimAlertCooldown(
      input.namespace,
      input.alert.event,
      now,
      ALERT_COOLDOWN_MS,
    );
  } catch (error) {
    console.error({
      event: "alert.cooldown_failed",
      alertEvent: input.alert.event,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return;
  }
  if (!claimed) return;
  try {
    await sendDiscordAlert(
      input.webhookUrl,
      {
        ...input.alert,
        environment: input.environment,
        occurredAt: input.alert.occurredAt ?? new Date(now).toISOString(),
      },
      input.fetcher,
    );
  } catch (error) {
    console.error({
      event: "alert.discord_delivery_failed",
      alertEvent: input.alert.event,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
}
