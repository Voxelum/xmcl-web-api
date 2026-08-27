import assert from "node:assert/strict";
import {
  billingOnlyAdminAccount,
  isStagingAccountRequest,
  isStagingAdminRequest,
  isStagingSharedHostingMutation,
  isStagingSharedModdedRuntimeRequest,
  isStagingUsageRequest,
  isRecentBrowserOAuthAdminPrincipal,
  issueStagingAdminSession,
  stagingAdminAuthenticator,
  verifiedAllowedAdminEmail,
  verifyStagingAdminSession,
} from "./worker.ts";

const stagingEnvironment = {
  XMCL_DEPLOYMENT_ENVIRONMENT: "staging",
  XMCL_HOME_RELEASE_ENABLED: "true",
  MONGODB_NAME: "coturn_staging",
  WAFFO_ENVIRONMENT: "test",
};

async function signedAdminToken(secret: string, claims: unknown) {
  const payload = btoa(JSON.stringify(claims))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(payload),
    ),
  );
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return `${payload}.${
    btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
  }`;
}

Deno.test("staging exposes billing-only accounts to Admin support", () => {
  const account = billingOnlyAdminAccount("acct_billing_only", {
    generatedAt: "2026-08-14T10:00:00.000Z",
    accounts: [{
      accountId: "acct_billing_only",
      balance: {
        accountId: "acct_billing_only",
        available: { currency: "USD", amountMinor: 201 },
        reserved: { currency: "USD", amountMinor: 0 },
      },
      paidCashMinor: 500,
      refundedCashMinor: 0,
    }],
    orders: [{
      orderId: "order_1",
      accountId: "acct_billing_only",
      provider: "waffo",
      status: "completed",
      cashAmount: { currency: "USD", amountMinor: 500 },
      refundedCashMinor: 0,
      createdAt: "2026-08-10T10:00:00.000Z",
      updatedAt: "2026-08-10T10:00:00.000Z",
    }],
    ledger: [],
  });

  assert.deepEqual(account, {
    accountId: "acct_billing_only",
    status: "billing_only",
    createdAt: "2026-08-10T10:00:00.000Z",
    identities: [],
  });
  assert.equal(
    billingOnlyAdminAccount("acct_missing", {
      generatedAt: "2026-08-14T10:00:00.000Z",
      accounts: [],
      orders: [],
      ledger: [],
    }),
    undefined,
  );
});

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
      "GET",
      "/v1/admin/shared-hosting/reconciliation",
    ),
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

Deno.test("staging exposes only the reviewed shared modded runtime routes", () => {
  for (
    const [method, path] of [
      ["POST", "/v1/shared-hosting/services/service_1/modpack-imports"],
      [
        "POST",
        "/v1/shared-hosting/services/service_1/runtime-terms-acceptance",
      ],
      ["POST", "/v1/shared-hosting/modpack-imports/import_1/upload-url"],
      ["POST", "/v1/shared-hosting/modpack-imports/import_1/complete"],
      ["POST", "/v1/shared-hosting/services/service_1/modpack-deployments"],
      ["GET", "/v1/shared-hosting/services/service_1/modpack-deployments"],
      ["POST", "/v1/shared-hosting/modpack-deployments/deployment_1/apply"],
      [
        "POST",
        "/v1/shared-hosting/services/service_1/modpack-deployments/deployment_1/rollback",
      ],
      [
        "POST",
        "/v1/internal/shared-runtime-compiler/deployments/deployment_1/published",
      ],
    ]
  ) {
    assert.equal(
      isStagingSharedModdedRuntimeRequest(method, path),
      true,
      `${method} ${path}`,
    );
  }
  assert.equal(
    isStagingSharedModdedRuntimeRequest(
      "GET",
      "/v1/internal/shared-runtime-compiler/deployments/deployment_1/published",
    ),
    false,
  );
  assert.equal(
    isStagingSharedModdedRuntimeRequest(
      "DELETE",
      "/v1/shared-hosting/modpack-imports/import_1",
    ),
    false,
  );
});

Deno.test("admin allowlist requires a provider-verified email", () => {
  const baseIdentity = {
    provider: "google" as const,
    subject: "google-user",
    email: "admin@example.com",
    linkedBy: "web_link" as const,
    linkedAt: "2026-08-14T00:00:00.000Z",
  };
  const account = {
    accountId: "acct_admin",
    status: "active" as const,
    createdAt: "2026-08-14T00:00:00.000Z",
    identities: [baseIdentity],
  };
  const allowlist = new Set(["admin@example.com"]);

  assert.equal(verifiedAllowedAdminEmail(account, allowlist), undefined);
  assert.equal(
    verifiedAllowedAdminEmail({
      ...account,
      identities: [{ ...baseIdentity, emailVerified: true as const }],
    }, allowlist),
    "admin@example.com",
  );
});

Deno.test("admin session requires a recent browser OAuth authentication", () => {
  const now = new Date("2026-08-14T10:00:00.000Z");
  assert.equal(isRecentBrowserOAuthAdminPrincipal({
    authenticationMethod: "browser_oauth",
    authenticatedAt: "2026-08-14T09:50:00.000Z",
  }, now), true);
  assert.equal(isRecentBrowserOAuthAdminPrincipal({
    authenticationMethod: "launcher",
    authenticatedAt: "2026-08-14T09:50:00.000Z",
  }, now), false);
  assert.equal(isRecentBrowserOAuthAdminPrincipal({
    authenticationMethod: "browser_oauth",
    authenticatedAt: "2026-08-14T09:44:59.000Z",
  }, now), false);
});

Deno.test("staging exposes only metered Home AI and TURN usage routes", () => {
  assert.equal(
    isStagingUsageRequest("POST", "/v1/chat/completions"),
    true,
  );
  assert.equal(isStagingUsageRequest("POST", "/v1/rtc/official"), true);
  assert.equal(isStagingUsageRequest("GET", "/v1/rtc/official"), false);
  assert.equal(isStagingUsageRequest("POST", "/v1/internal/usage/ai"), false);
});

Deno.test("staging exposes the reviewed hosted-server mutation surface", () => {
  for (
    const path of [
      "/v1/shared-hosting/subscriptions",
      "/v1/shared-hosting/subscriptions/subscription_123/cancel",
      "/v1/shared-hosting/services",
      "/v1/shared-hosting/services/service_123/start",
      "/v1/shared-hosting/services/service_123/stop",
    ]
  ) {
    assert.equal(isStagingSharedHostingMutation("POST", path), true, path);
  }
  assert.equal(
    isStagingSharedHostingMutation(
      "POST",
      "/v1/shared-hosting/services/service_123/export",
    ),
    false,
  );
  assert.equal(
    isStagingSharedHostingMutation(
      "DELETE",
      "/v1/shared-hosting/services/service_123",
    ),
    false,
  );
});

Deno.test("staging admin bearer authenticates independently", async () => {
  const staticToken = "staging-static-token";
  const authenticator = stagingAdminAuthenticator(
    staticToken,
    "staging-session-secret",
  );
  assert.ok(authenticator);
  assert.equal(
    await authenticator.authenticate(["Bearer", "wrong-secret"].join(" ")),
    undefined,
  );
  const principal = await authenticator.authenticate(
    ["Bearer", staticToken].join(" "),
  );
  assert.equal(principal?.id, "staging-billing-operator");
  assert.deepEqual(principal?.scopes, ["billing_operator"]);
});

Deno.test("staging admin sessions are signed, scoped, and short-lived", async () => {
  const secret = "staging-admin-secret-with-sufficient-entropy";
  const session = await issueStagingAdminSession(secret, "account_123");
  assert.ok(Date.parse(session.expiresAt) > Date.now());
  assert.ok(Date.parse(session.expiresAt) <= Date.now() + 15 * 60_000 + 1000);

  const principal = await stagingAdminAuthenticator(undefined, secret)
    ?.authenticate(
    `Bearer ${session.accessToken}`,
  );
  assert.equal(principal?.id, "account_123");
  assert.deepEqual(principal?.scopes, ["admin"]);
  assert.equal(
    await stagingAdminAuthenticator(undefined, "different-secret")
      ?.authenticate(
      `Bearer ${session.accessToken}`,
    ),
    undefined,
  );
});

Deno.test("staging admin sessions reject malformed expiry claims", async () => {
  const secret = "staging-admin-secret-with-sufficient-entropy";
  const invalid = await signedAdminToken(secret, {
    version: 2,
    accountId: "account_123",
    authenticatedAt: new Date().toISOString(),
    expiresAt: "not-a-date",
  });
  assert.equal(
    await verifyStagingAdminSession(secret, invalid),
    undefined,
  );
});
