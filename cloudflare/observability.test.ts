import assert from "node:assert/strict";
import {
  observeWorkerRequest,
  workerErrorFields,
} from "./observability.ts";

Deno.test("Worker observability records failed responses without query or body data", async () => {
  const warnings: unknown[] = [];
  const errors: unknown[] = [];
  const request = new Request(
    "https://api.xmcl.app/v1/sessions/refresh?token=must-not-log",
    {
      method: "POST",
      headers: { "cf-ray": "ray-1" },
      body: JSON.stringify({ refreshToken: "must-not-log" }),
    },
  );

  const response = await observeWorkerRequest(
    request,
    () => Promise.resolve(new Response("private response", { status: 429 })),
    {
      warn: (value) => warnings.push(value),
      error: (value) => errors.push(value),
    },
    () => 100,
  );

  assert.equal(response.status, 429);
  assert.equal(errors.length, 0);
  assert.deepEqual(warnings, [{
    event: "worker.response",
    requestId: "ray-1",
    method: "POST",
    path: "/v1/sessions/refresh",
    cfRay: "ray-1",
    colo: undefined,
    status: 429,
    durationMs: 0,
  }]);
  assert.doesNotMatch(JSON.stringify(warnings), /must-not-log|private response/);
});

Deno.test("Worker observability omits exception messages and rethrows", async () => {
  const errors: unknown[] = [];
  const failure = new Error(
    "fetch mongodb+srv://user:password@example/db?token=secret failed for Bearer access-token and rfr_refresh-token",
  );

  await assert.rejects(
    () =>
      observeWorkerRequest(
        new Request("https://api.xmcl.app/ai/chat/completions"),
        () => Promise.reject(failure),
        { warn: () => {}, error: (value) => errors.push(value) },
        () => 200,
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "ObservedWorkerError" &&
      !error.message.includes("access-token"),
  );

  const serialized = JSON.stringify(errors);
  assert.match(serialized, /worker\.exception/);
  assert.match(serialized, /"errorName":"Error"/);
  assert.doesNotMatch(
    serialized,
    /user:password|access-token|refresh-token|token=secret/,
  );
});

Deno.test("Worker error fields omit arbitrary thrown values", () => {
  assert.deepEqual(workerErrorFields({ secret: "must-not-log" }), {
    errorName: "UnknownError",
  });
});
