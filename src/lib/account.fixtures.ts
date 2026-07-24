/**
 * Account-local contract proposal fixtures. These intentionally live outside
 * contracts/ until the shared contract owner publishes the Account schema.
 */
export const accountApiFixtures = {
  launcherExchangeRequest: {
    loginTransactionId: "ltx_fixture_001",
    completedAt: "2026-07-22T14:00:00.000Z",
    credential: "<provider-credential>",
  },
  launcherExchangeResponse: {
    account: {
      accountId: "acct_fixture_001",
      status: "active",
      createdAt: "2026-07-22T14:00:00.000Z",
    },
    bindingDisposition: "created",
    session: {
      sessionId: "ses_fixture_001",
      accountId: "acct_fixture_001",
      accessToken: "<xmcl-access-token>",
      refreshToken: "<xmcl-refresh-token>",
      scopes: ["account:read", "account:write", "session:manage"],
      issuedAt: "2026-07-22T14:00:00.000Z",
      expiresAt: "2026-07-23T14:00:00.000Z",
    },
  },
  errors: {
    permission: {
      status: 403,
      body: {
        error: "insufficient_scope",
        message: "Required scope is missing",
        requestId: "req_fixture_permission",
      },
    },
    identityConflict: {
      status: 409,
      body: {
        error: "identity_conflict",
        message: "Identity belongs to another account",
        requestId: "req_fixture_conflict",
        details: { mergeAvailable: true },
      },
    },
    providerFailure: {
      status: 503,
      body: {
        error: "provider_unavailable",
        message: "provider_unavailable",
        requestId: "req_fixture_provider",
      },
    },
  },
  idempotencyRetry: {
    request: {
      path: "/v1/account/deletion",
      headers: { "Idempotency-Key": "delete-fixture-001" },
    },
    expectation: "same taskId and deletionEffectiveAt",
  },
  proposedAccountMergedEvent: {
    schemaVersion: 0,
    status: "local-proposal",
    eventId: "evt_fixture_merge_001",
    type: "account.merged",
    idempotencyKey: "mrg_fixture_001",
    sourceAccountId: "acct_fixture_source",
    targetAccountId: "acct_fixture_destination",
    occurredAt: "2026-07-22T14:00:00.000Z",
  },
} as const;
