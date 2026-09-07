import assert from "node:assert/strict";
import { getFlights } from "./flights.ts";

Deno.test("agent telemetry remains explicitly disabled to clear launcher caches", () => {
  assert.deepEqual(getFlights("0.68.1", "en-US", "1483"), {
    agentTelemetry: false,
    i18nSearch: ["zh-CN", "zh-TW", "ru"],
  });
  assert.deepEqual(getFlights("0.69.0", "zh-CN", "1489"), {
    agentTelemetry: false,
    i18nSearch: ["zh-CN", "zh-TW", "ru"],
  });
});

Deno.test("flights still reject incomplete requests", () => {
  assert.deepEqual(getFlights(null, "en-US", "1483"), {});
  assert.deepEqual(getFlights("0.68.1", null, "1483"), {});
});
