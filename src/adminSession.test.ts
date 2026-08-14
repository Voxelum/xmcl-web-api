import assert from "node:assert/strict";
import {
  adminSessionAuthenticator,
  issueAdminSession,
  isRecentBrowserOAuthPrincipal,
} from "./adminSession.ts";

Deno.test("production admin sessions are signed and short-lived", async () => {
  const secret = "production-admin-secret-with-sufficient-entropy";
  const session = await issueAdminSession(secret, "account_123");
  const principal = await adminSessionAuthenticator(secret)!.authenticate(
    `Bearer ${session.accessToken}`,
  );
  assert.equal(principal?.id, "account_123");
  assert.deepEqual(principal?.scopes, ["admin"]);
  assert.ok(Date.parse(session.expiresAt) <= Date.now() + 15 * 60_000 + 1_000);
  assert.equal(
    await adminSessionAuthenticator("wrong-secret")!.authenticate(
      `Bearer ${session.accessToken}`,
    ),
    undefined,
  );
});

Deno.test("production admin elevation requires recent browser OAuth", () => {
  const now = new Date("2026-08-15T00:00:00.000Z");
  assert.equal(isRecentBrowserOAuthPrincipal({
    authenticationMethod: "browser_oauth",
    authenticatedAt: "2026-08-14T23:50:00.000Z",
  }, now), true);
  assert.equal(isRecentBrowserOAuthPrincipal({
    authenticationMethod: "launcher",
    authenticatedAt: "2026-08-14T23:50:00.000Z",
  }, now), false);
});
