import assert from "node:assert/strict";
import { createMicrosoftOAuth } from "./microsoft.ts";

Deno.test("redeems Microsoft public-client codes with PKCE and no client secret", async () => {
  const requests: Request[] = [];
  const adapter = createMicrosoftOAuth({
    clientId: "microsoft-public-client",
    redirectUris: ["https://www.xmcl.app/oauth/callback"],
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.includes("/oauth2/v2.0/token")) {
        return Response.json({ access_token: "provider-access-token" });
      }
      return Response.json({
        id: "microsoft-user",
        displayName: "Demo User",
        mail: "Admin@Example.COM",
      });
    },
  });

  const identity = await adapter.exchange({
    code: "authorization-code",
    codeVerifier: "pkce-verifier",
    redirectUri: "https://www.xmcl.app/oauth/callback",
  });

  assert.deepEqual(identity, {
    provider: "microsoft",
    subject: "microsoft-user",
    displayName: "Demo User",
    email: "admin@example.com",
    emailVerified: true,
  });
  assert.equal(
    requests[0].url,
    "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
  );
  assert.equal(requests[0].headers.get("origin"), "https://www.xmcl.app");
  const form = new URLSearchParams(await requests[0].text());
  assert.equal(form.get("client_id"), "microsoft-public-client");
  assert.equal(form.get("code_verifier"), "pkce-verifier");
  assert.equal(form.has("client_secret"), false);
});

Deno.test("Microsoft launcher credentials do not establish verified email trust", async () => {
  const adapter = createMicrosoftOAuth({
    clientId: "microsoft-public-client",
    redirectUris: [],
    fetch: async () =>
      Response.json({
        id: "microsoft-user",
        displayName: "Demo User",
        mail: "Admin@Example.COM",
      }),
  });

  assert.deepEqual(
    await adapter.verifyLauncherCredential({
      accessToken: "graph-token",
      completedAt: "2026-08-14T00:00:00.000Z",
    }),
    {
      provider: "microsoft",
      subject: "microsoft-user",
      displayName: "Demo User",
      email: "admin@example.com",
    },
  );
});
