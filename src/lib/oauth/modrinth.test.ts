import assert from "node:assert/strict";
import { createModrinthOAuth, DEFAULT_MODRINTH_CLIENT_ID } from "./modrinth.ts";

Deno.test("uses the configured Modrinth OAuth client and client secret for browser exchange", async () => {
  const requests: Request[] = [];
  const adapter = createModrinthOAuth({
    redirectUris: ["https://preview.example.invalid/oauth/callback"],
    clientId: "configured-modrinth-client",
    clientSecret: "configured-modrinth-secret",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.includes("/oauth/token")) {
        return Response.json({ access_token: "provider-access-token" });
      }
      return Response.json({ id: "modrinth-user", username: "Demo User" });
    },
  });

  assert.equal(
    new URL(adapter.authorizationUrl({
      state: "state",
      nonce: "nonce",
      codeChallenge: "challenge",
      redirectUri: "https://preview.example.invalid/oauth/callback",
    })).searchParams.get("client_id"),
    "configured-modrinth-client",
  );

  const identity = await adapter.exchange({
    code: "code",
    codeVerifier: "verifier",
    redirectUri: "https://preview.example.invalid/oauth/callback",
  });

  assert.deepEqual(identity, {
    provider: "modrinth",
    subject: "modrinth-user",
    displayName: "Demo User",
  });
  assert.equal(
    requests[0].headers.get("authorization"),
    null,
  );
  const form = new URLSearchParams(await requests[0].text());
  assert.equal(form.get("client_id"), "configured-modrinth-client");
  assert.equal(form.get("client_secret"), "configured-modrinth-secret");
});

Deno.test("uses the existing registered Modrinth client ID by default", () => {
  const adapter = createModrinthOAuth({ redirectUris: [] });
  assert.equal(
    new URL(adapter.authorizationUrl({
      state: "state",
      nonce: "nonce",
      codeChallenge: "challenge",
      redirectUri: "https://preview.example.invalid/oauth/callback",
    })).searchParams.get("client_id"),
    DEFAULT_MODRINTH_CLIENT_ID,
  );
});
