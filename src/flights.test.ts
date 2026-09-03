import assert from "node:assert/strict";
import { getFlights } from "./flights.ts";

Deno.test("agent telemetry is enabled only for current launcher versions", () => {
  assert.deepEqual(getFlights("0.67.3", "en-US", "1452"), {
    i18nSearch: ["zh-CN", "zh-TW", "ru"],
  });
  assert.deepEqual(getFlights("0.68.0", "en-US", "1452"), {
    i18nSearch: ["zh-CN", "zh-TW", "ru"],
    agentTelemetry: true,
  });
  assert.deepEqual(getFlights("0.68.1", "zh-CN", "1452"), {
    i18nSearch: ["zh-CN", "zh-TW", "ru"],
    agentTelemetry: true,
  });
});

Deno.test("agent telemetry flight fails closed for malformed or missing versions", () => {
  assert.deepEqual(getFlights("not-semver", "en-US", "1452"), {
    i18nSearch: ["zh-CN", "zh-TW", "ru"],
  });
  assert.deepEqual(getFlights(null, "en-US", "1452"), {});
  assert.deepEqual(getFlights("0.68.1", null, "1452"), {});
});
