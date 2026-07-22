import assert from "node:assert/strict";

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await Deno.readTextFile(new URL(path, import.meta.url)));
}

function validate(schema: Record<string, unknown>, value: unknown) {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  const object = value as Record<string, unknown>;
  for (const key of schema.required as string[]) {
    assert.ok(key in object, `missing required ${key}`);
  }
  for (
    const [key, property] of Object.entries(
      schema.properties as Record<string, Record<string, unknown>>,
    )
  ) {
    if (!(key in object)) continue;
    const candidate = object[key];
    if (property.const !== undefined) assert.equal(candidate, property.const);
    if (property.enum !== undefined) {
      assert.ok((property.enum as unknown[]).includes(candidate));
    }
    if (property.type === "string") assert.equal(typeof candidate, "string");
    if (property.type === "integer") {
      assert.equal(Number.isInteger(candidate), true);
    }
    if (property.type === "array") assert.equal(Array.isArray(candidate), true);
  }
}

Deno.test("M9 promotion proposal schemas and success/error fixtures validate", async () => {
  const validationSchema = await json(
    "./schemas/modpack-validation-report.schema.json",
  );
  const taskSchema = await json("./schemas/async-task.schema.json");
  const eventSchema = await json("./events/deployment-worker.schema.json");

  validate(validationSchema, await json("./fixtures/validation-success.json"));
  validate(taskSchema, await json("./fixtures/task-success.json"));
  validate(taskSchema, await json("./fixtures/task-error-stopped.json"));

  const events = JSON.parse(
    await Deno.readTextFile(
      new URL("./fixtures/ordered-worker-events.json", import.meta.url),
    ),
  ) as unknown[];
  assert.equal(events.length, 2);
  for (const event of events) validate(eventSchema, event);
  assert.equal((events[0] as { sequence: number }).sequence, 1);
  assert.equal((events[1] as { sequence: number }).sequence, 2);

  const retry = await json("./fixtures/retry-idempotency-conflict.json");
  assert.equal(retry.error, "idempotency_conflict");
  const openapi = await Deno.readTextFile(
    new URL("./openapi.yaml", import.meta.url),
  );
  assert.match(openapi, /\/v1\/modpack-deployments\/\{deploymentId\}\/apply/);
});
