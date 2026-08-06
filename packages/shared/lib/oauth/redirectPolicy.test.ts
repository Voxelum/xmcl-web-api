import assert from "node:assert/strict";
import {
  createOAuthRedirectPolicy,
  isLauncherCallback,
} from "./redirectPolicy.ts";

Deno.test("launcher redirect policy accepts only the launcher port sequence", () => {
  assert.equal(
    isLauncherCallback("http://127.0.0.1:25555/commercial-auth"),
    true,
  );
  assert.equal(
    isLauncherCallback("http://127.0.0.1:25562/commercial-auth"),
    true,
  );

  for (
    const redirectUri of [
      "http://127.0.0.1:25556/commercial-auth",
      "http://attacker.invalid:25555/commercial-auth",
      "http://localhost:25555/commercial-auth",
      "http://127.0.0.1:25555/commercial-auth?next=https://attacker.invalid",
      "http://127.0.0.1:25555/commercial-auth#attacker",
      "http://user@127.0.0.1:25555/commercial-auth",
    ]
  ) {
    assert.equal(isLauncherCallback(redirectUri), false, redirectUri);
  }
});

Deno.test("OAuth redirect policy allows only exact configured HTTPS web callbacks", () => {
  const webCallback = "https://xmcl.app/oauth/callback";
  const policy = createOAuthRedirectPolicy([
    webCallback,
    "http://xmcl.app/oauth/callback",
    "https://*.xmcl.app/oauth/callback",
    "https://xmcl.app/oauth/callback?next=ignored",
    "https://xmcl.app/oauth/callback#ignored",
  ]);

  assert.deepEqual(policy.declaredRedirectUris, [webCallback]);
  assert.equal(policy.allows(webCallback), true);
  assert.equal(policy.allows("https://xmcl.app/oauth/callback/"), false);
  assert.equal(
    policy.allows("http://127.0.0.1:25555/commercial-auth"),
    true,
  );
});
