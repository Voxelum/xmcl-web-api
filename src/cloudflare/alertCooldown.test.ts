import assert from "node:assert/strict";
import { AlertCooldownObject } from "./alertCooldown.ts";
import type { DurableObjectState } from "./types.ts";

Deno.test("alert cooldown claims once until the shared window expires", async () => {
  const values = new Map<string, unknown>();
  const object = new AlertCooldownObject({
    id: {} as never,
    storage: {
      get: <T>(key: string) => Promise.resolve(values.get(key) as T),
      put: (key: string, value: unknown) => {
        values.set(key, value);
        return Promise.resolve();
      },
    },
  } as unknown as DurableObjectState);
  const request = (
    action: "claim" | "release",
    now: number,
  ) =>
    object.fetch(new Request("https://alerts.internal/claim", {
      method: "POST",
      body: JSON.stringify({
        action,
        key: "turn.staging_metering.failed",
        now,
        cooldownMs: 900_000,
      }),
    }));

  assert.deepEqual(await (await request("claim", 1_000)).json(), {
    claimed: true,
    nextAllowedAt: 901_000,
  });
  assert.deepEqual(await (await request("claim", 61_000)).json(), {
    claimed: false,
    nextAllowedAt: 901_000,
  });
  assert.deepEqual(await (await request("release", 61_000)).json(), {
    released: true,
  });
  assert.deepEqual(await (await request("claim", 61_000)).json(), {
    claimed: true,
    nextAllowedAt: 961_000,
  });
});
