import type {
  DurableObjectNamespace,
  DurableObjectState,
} from "./types.ts";

interface CooldownRequest {
  action: "claim" | "release";
  key: string;
  now: number;
  cooldownMs: number;
}

export class AlertCooldownObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    const input = await request.json() as Partial<CooldownRequest>;
    if (
      typeof input.key !== "string" ||
      !/^[a-z0-9._:-]{1,160}$/.test(input.key) ||
      !Number.isSafeInteger(input.now) ||
      !Number.isSafeInteger(input.cooldownMs) ||
      input.cooldownMs! <= 0 ||
      !["claim", "release"].includes(input.action ?? "")
    ) {
      return new Response("Bad Request", { status: 400 });
    }
    if (input.action === "release") {
      await this.state.storage.put(input.key, 0);
      return Response.json({ released: true });
    }
    const nextAllowedAt = await this.state.storage.get<number>(input.key);
    if (
      input.action === "claim" &&
      nextAllowedAt !== undefined &&
      nextAllowedAt > input.now!
    ) {
      return Response.json({ claimed: false, nextAllowedAt });
    }
    const next = input.now! + input.cooldownMs!;
    await this.state.storage.put(input.key, next);
    return Response.json({ claimed: true, nextAllowedAt: next });
  }
}

export async function claimAlertCooldown(
  namespace: DurableObjectNamespace,
  key: string,
  now: number,
  cooldownMs: number,
) {
  const stub = namespace.get(namespace.idFromName("together-alerts"));
  const response = await stub.fetch(
    new Request("https://alerts.internal/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "claim", key, now, cooldownMs }),
    }),
  );
  if (!response.ok) throw new Error("Alert cooldown claim failed");
  const body = await response.json() as { claimed?: unknown };
  if (typeof body.claimed !== "boolean") {
    throw new Error("Alert cooldown returned an invalid response");
  }
  return body.claimed;
}

export async function releaseAlertCooldown(
  namespace: DurableObjectNamespace,
  key: string,
) {
  await updateAlertCooldown(namespace, "release", key, Date.now(), 1);
}

async function updateAlertCooldown(
  namespace: DurableObjectNamespace,
  action: "release",
  key: string,
  now: number,
  cooldownMs: number,
) {
  const stub = namespace.get(namespace.idFromName("together-alerts"));
  const response = await stub.fetch(
    new Request("https://alerts.internal/cooldown", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, key, now, cooldownMs }),
    }),
  );
  if (!response.ok) throw new Error("Alert cooldown update failed");
}
