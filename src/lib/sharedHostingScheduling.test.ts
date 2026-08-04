import assert from "node:assert/strict";
import {
  runSharedHostingBillingScheduledSweep,
  SharedHostingBillingSchedulingConfigurationError,
} from "./sharedHostingScheduling.ts";

Deno.test("shared hosting billing sweep passes a UTC instant to renewDue", async () => {
  let received: Date | undefined;
  const result = await runSharedHostingBillingScheduledSweep({
    renewDue: async (at) => {
      received = at;
      return { renewed: ["sub_1"], paymentDue: [], cancelled: [] };
    },
  }, "2026-08-24T00:00:00.000Z");
  assert.equal(received?.toISOString(), "2026-08-24T00:00:00.000Z");
  assert.deepEqual(result.renewed, ["sub_1"]);
});

Deno.test("shared hosting billing sweep rejects missing trusted work", async () => {
  await assert.rejects(
    () =>
      runSharedHostingBillingScheduledSweep(
        undefined,
        "2026-08-24T00:00:00.000Z",
      ),
    SharedHostingBillingSchedulingConfigurationError,
  );
});
