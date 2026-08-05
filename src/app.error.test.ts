import assert from "node:assert/strict";
import { createApp } from "./app.ts";

Deno.test("application errors are correlated and sanitized", async () => {
  const originalError = console.error;
  const logs: unknown[] = [];
  console.error = (...values: unknown[]) => logs.push(values);
  try {
    const app = createApp((mounted) => {
      mounted.get("/diagnostic-error", () => {
        throw new Error(
          "Mongo failed at mongodb+srv://user:password@example.invalid/db",
        );
      });
    });
    const response = await app.request("/diagnostic-error", {
      headers: { "x-request-id": "req-diagnostic" },
    });
    const body = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(body, {
      error: "internal_error",
      message: "Internal Server Error",
      requestId: "req-diagnostic",
    });
    const serializedLogs = JSON.stringify(logs);
    assert.match(serializedLogs, /app\.exception/);
    assert.match(serializedLogs, /req-diagnostic/);
    assert.doesNotMatch(serializedLogs, /user:password/);
  } finally {
    console.error = originalError;
  }
});

Deno.test("isolated route surfaces expose only their owned APIs", () => {
  const aiPaths = createApp(undefined, { routeSurface: "ai" }).routes.map(
    (route) => route.path,
  );
  assert.equal(aiPaths.includes("/v1/chat/completions"), true);
  assert.equal(aiPaths.includes("/translation"), false);
  assert.equal(aiPaths.includes("/v1/rtc/official"), false);

  const signalingPaths = createApp(undefined, { routeSurface: "signaling" })
    .routes.map((route) => route.path);
  assert.equal(signalingPaths.includes("/group/:id"), false);
  assert.equal(signalingPaths.includes("/v1/multiplayer/rooms"), true);
  assert.equal(signalingPaths.includes("/v1/rtc/official"), true);
  assert.equal(signalingPaths.includes("/v1/chat/completions"), false);
  assert.equal(signalingPaths.includes("/translation"), false);
});
