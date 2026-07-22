import assert from "node:assert/strict";

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await Deno.readTextFile(new URL(path, import.meta.url)));
}

Deno.test("M5 publication proposal parses and references shared v1 without copying it", async () => {
  const openapi = await Deno.readTextFile(
    new URL("./openapi.yaml", import.meta.url),
  );
  assert.match(openapi, /\/worker\/register/);
  assert.match(openapi, /\/worker\/heartbeat/);
  assert.match(openapi, /\/worker\/events/);
  assert.match(openapi, /\/worker\/usage/);
  assert.match(openapi, /\/worker\/logs/);
  assert.match(openapi, /canonical-usage-event\.schema\.json/);
  assert.match(openapi, /balance-exhaustion\.schema\.json/);
  assert.doesNotMatch(openapi, /"eventType": "usage\.recorded\.v1"/);

  for (
    const path of [
      "./schemas/worker-token.schema.json",
      "./schemas/worker-heartbeat.schema.json",
      "./schemas/runtime-event.schema.json",
      "./schemas/worker-usage.schema.json",
      "./fixtures/auth-replay.json",
      "./fixtures/out-of-order.json",
      "./fixtures/settlement-stop-required.json",
      "./fixtures/provider-failure.json",
    ]
  ) {
    assert.equal(typeof await json(path), "object");
  }

  const settlement = await json("./fixtures/settlement-stop-required.json");
  const canonicalFixture = settlement.sharedCanonicalUsageFixture as string;
  const stoppedSchema = settlement.sharedStoppedEventSchema as string;
  assert.equal(typeof canonicalFixture, "string");
  assert.equal(typeof stoppedSchema, "string");
  await Deno.stat(
    new URL(canonicalFixture, new URL("./fixtures/", import.meta.url)),
  );
  await Deno.stat(
    new URL(stoppedSchema, new URL("./fixtures/", import.meta.url)),
  );
});
