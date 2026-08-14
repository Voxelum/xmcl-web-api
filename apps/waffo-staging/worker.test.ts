import assert from "node:assert/strict";
import {
  isStagingAccountRequest,
  isStagingAdminRequest,
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
  assert.equal(
    isStagingAdminRequest(
      "POST",
      "/v1/admin/accounts/account_123/refunds",
    ),
    false,
  );
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
