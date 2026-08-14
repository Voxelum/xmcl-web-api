import assert from "node:assert/strict";
import { createModrinthTokenRequest } from "./modrinth.ts";

function createRequest(config: Record<string, string>) {
  return createModrinthTokenRequest(
    config,
    "code",
    "http://127.0.0.1/callback",
    "XMCL test",
  );
}

Deno.test("preserves the legacy Modrinth Authorization credential", async () => {
  const request = createRequest({
    MODRINTH_SECRET: "Basic legacy-credential",
  });

  assert.equal(
    request.headers.get("authorization"),
    "Basic legacy-credential",
  );
  const form = new URLSearchParams(await request.text());
  assert.equal(form.get("client_secret"), null);
});

Deno.test("prefers the raw Modrinth client secret when configured", async () => {
  const request = createRequest({
    MODRINTH_SECRET: "Basic legacy-credential",
    XMCL_MODRINTH_CLIENT_SECRET: "raw-client-secret",
  });

  assert.equal(
    request.headers.get("authorization"),
    "raw-client-secret",
  );
  const form = new URLSearchParams(await request.text());
  assert.equal(form.get("client_secret"), null);
});
