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
