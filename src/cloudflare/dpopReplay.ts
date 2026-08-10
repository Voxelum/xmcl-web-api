import type { DurableObjectNamespace, DurableObjectState } from "./types.ts";
import type { DpopReplayStore } from "../dpop.ts";

const REPLAY_SHARDS = 256;
const STORAGE_KEY = "entries";

export class DpopReplayObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    let body: { key?: unknown; expiresAt?: unknown };
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid request", { status: 400 });
    }
    if (
      typeof body.key !== "string" || !body.key ||
      body.key.length > 256 ||
      typeof body.expiresAt !== "number" ||
      !Number.isFinite(body.expiresAt)
    ) {
      return new Response("Invalid request", { status: 400 });
    }

    const now = Date.now();
    const entries = await this.readEntries(now);
    if ((entries[body.key] ?? 0) > now) {
      return Response.json({ consumed: false });
    }
    entries[body.key] = body.expiresAt;
    await this.state.storage.put(STORAGE_KEY, entries);
    await this.schedule(entries);
    return Response.json({ consumed: true });
  }

  async alarm() {
    const entries = await this.readEntries(Date.now());
    if (Object.keys(entries).length === 0) {
      await this.state.storage.deleteAll();
      await this.state.storage.deleteAlarm();
      return;
    }
    await this.state.storage.put(STORAGE_KEY, entries);
    await this.schedule(entries);
  }

  private async readEntries(now: number) {
    const entries = await this.state.storage.get<Record<string, number>>(
      STORAGE_KEY,
    ) ?? {};
    for (const [key, expiresAt] of Object.entries(entries)) {
      if (expiresAt <= now) delete entries[key];
    }
    return entries;
  }

  private async schedule(entries: Record<string, number>) {
    const next = Math.min(...Object.values(entries));
    if (Number.isFinite(next)) {
      await this.state.storage.setAlarm(Math.max(next, Date.now() + 1_000));
    }
  }
}

export function createCloudflareDpopReplayStore(
  namespace: DurableObjectNamespace,
): DpopReplayStore {
  return {
    async consume(key, expiresAt) {
      const shard = shardFor(key);
      const stub = namespace.get(namespace.idFromName(`dpop-${shard}`));
      const response = await stub.fetch(
        new Request("https://dpop/consume", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key, expiresAt }),
        }),
      );
      if (!response.ok) {
        throw new Error(
          `DPoP replay store failed with HTTP ${response.status}`,
        );
      }
      const body = await response.json() as { consumed?: unknown };
      if (typeof body.consumed !== "boolean") {
        throw new Error("DPoP replay store returned an invalid response");
      }
      return body.consumed;
    },
  };
}

function shardFor(key: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % REPLAY_SHARDS;
}
