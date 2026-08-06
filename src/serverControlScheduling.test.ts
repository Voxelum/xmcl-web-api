import assert from "node:assert/strict";
import {
  runServerControlScheduledSweep,
  ServerControlSchedulingConfigurationError,
} from "./serverControlScheduling.ts";

Deno.test("scheduled ServerControl sweep requires an injected production adapter", async () => {
  await assert.rejects(
    () =>
      runServerControlScheduledSweep(undefined, "2026-07-22T14:10:00.000Z"),
    ServerControlSchedulingConfigurationError,
  );
});

Deno.test("scheduled ServerControl sweep forwards the deterministic scheduled timestamp", async () => {
  let observed = "";
  const result = await runServerControlScheduledSweep({
    sweepExpiredStops(at) {
      observed = at;
      return Promise.resolve([
        { accountId: "account_1", taskId: "task_1", status: "forced" },
      ]);
    },
  }, "2026-07-22T14:10:00.000Z");
  assert.equal(observed, "2026-07-22T14:10:00.000Z");
  assert.deepEqual(result, [
    { accountId: "account_1", taskId: "task_1", status: "forced" },
  ]);
});
