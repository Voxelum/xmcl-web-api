import assert from "node:assert/strict";
import { DpopReplayObject } from "./dpopReplay.ts";
import type { DurableObjectState } from "./types.ts";

Deno.test("DPoP replay object atomically consumes a proof once", async () => {
  const values = new Map<string, unknown>();
  const state = {
    storage: {
      get: <T>(key: string) => Promise.resolve(values.get(key) as T),
      put: <T>(key: string, value: T) => {
        values.set(key, structuredClone(value));
        return Promise.resolve();
      },
      setAlarm: () => Promise.resolve(),
      deleteAlarm: () => Promise.resolve(),
      deleteAll: () => {
        values.clear();
        return Promise.resolve();
      },
    },
  } as unknown as DurableObjectState;
  const object = new DpopReplayObject(state);
  const consume = () =>
    object.fetch(
      new Request("https://dpop/consume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key: "thumbprint:proof-id",
          expiresAt: Date.now() + 60_000,
        }),
      }),
    );

  const first = await consume();
  const second = await consume();

  assert.deepEqual(await first.json(), { consumed: true });
  assert.deepEqual(await second.json(), { consumed: false });
});
