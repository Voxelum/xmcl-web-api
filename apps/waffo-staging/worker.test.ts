import assert from "node:assert/strict";
import {
  isStagingAccountRequest,
  isStagingAdminRequest,
  issueStagingAdminSession,
  stagingAdminAuthenticator,
} from "./worker.ts";

Deno.test("staging exposes the reviewed account and OAuth surface", () => {
  for (
    const [method, path] of [
      ["GET", "/v1/auth/google/authorize"],
      ["POST", "/v1/auth/google/exchange"],
      ["POST", "/v1/sessions/refresh"],
      ["GET", "/v1/account"],
      ["POST", "/v1/account/identities/google/authorize"],
      ["DELETE", "/v1/account/identities/google"],
      ["OPTIONS", "/v1/account"],
    ]
  ) {
    assert.equal(
      isStagingAccountRequest(method, path),
      true,
      `${method} ${path}`,
    );
  }
  assert.equal(
    isStagingAccountRequest("GET", "/v1/auth/google/exchange"),
    false,
  );
});

Deno.test("staging admin surface remains read-only", () => {
  assert.equal(
    isStagingAdminRequest("GET", "/v1/admin/billing/overview"),
    true,
  );
  assert.equal(
    isStagingAdminRequest("GET", "/v1/admin/accounts/account_123"),
    true,
  );
  assert.equal(isStagingAdminRequest("GET", "/v1/admin/accounts"), true);
  assert.equal(isStagingAdminRequest("POST", "/v1/admin/session"), true);
  assert.equal(
    isStagingAdminRequest(
      "POST",
      "/v1/admin/accounts/account_123/refunds",
    ),
    false,
  );
});

Deno.test("staging keeps hosted-server mutations disabled", async () => {
  const worker = (await import("./worker.ts")).default;
  for (
    const path of [
      "/v1/shared-hosting/subscriptions",
      "/v1/shared-hosting/services",
      "/v1/shared-hosting/services/service_123/start",
      "/v1/shared-hosting/services/service_123/stop",
    ]
  ) {
    const response = await worker.fetch(
      new Request(`https://api-staging.xmcl.app${path}`, { method: "POST" }),
      {} as never,
      { waitUntil() {}, passThroughOnException() {} } as never,
    );
    assert.equal(response.status, 404, path);
  }
});

Deno.test("staging admin bearer authenticates independently", async () => {
  const authenticator = stagingAdminAuthenticator("staging-secret");
  assert.ok(authenticator);
  assert.equal(
    await authenticator.authenticate("Bearer wrong-secret"),
    undefined,
  );
  const principal = await authenticator.authenticate(
    "Bearer staging-secret",
  );
  assert.equal(principal?.id, "staging-billing-operator");
  assert.deepEqual(principal?.scopes, ["billing_operator"]);
});

Deno.test("staging admin sessions are signed, scoped, and short-lived", async () => {
  const secret = "staging-admin-secret-with-sufficient-entropy";
  const session = await issueStagingAdminSession(secret, "account_123");
  assert.ok(Date.parse(session.expiresAt) > Date.now());
  assert.ok(Date.parse(session.expiresAt) <= Date.now() + 15 * 60_000 + 1000);

  const principal = await stagingAdminAuthenticator(secret)?.authenticate(
    `Bearer ${session.accessToken}`,
  );
  assert.equal(principal?.id, "account_123");
  assert.deepEqual(principal?.scopes, ["admin"]);
  assert.equal(
    await stagingAdminAuthenticator("different-secret")?.authenticate(
      `Bearer ${session.accessToken}`,
    ),
    undefined,
  );
});
