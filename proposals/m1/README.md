# M1 account and identity publication proposal v1

This is a module-local submission for shared-contract-owner promotion. It does
not modify `contracts/`.

## Proposed artifacts

- `openapi.yaml` — account, session, browser OAuth, launcher exchange, identity,
  explicit merge, and deletion endpoints.
- `account.schema.json`, `identity.schema.json`, and `session.schema.json` —
  public response models. Identity responses intentionally omit provider
  subjects; provider credentials never appear outside an exchange request.
- `events/session-lifecycle.schema.json` and `events/account-merge.schema.json`
  — sanitized, idempotent audit/outbox event envelopes proposed for M1
  publication.
- `fixtures/` — stable success/error fixtures required for consumer contract
  tests.

## Bearer XMCL session transport

Authenticated requests use only `Authorization: Bearer <XMCL access token>`. The
access token expires after 24 hours, is scoped, and identifies an opaque
`accountId` plus session/family IDs. It is never sent in URLs, persisted by a
renderer, written to ordinary logs, or included in events. Refresh tokens are
accepted only in `POST /v1/sessions/refresh` JSON bodies; a replay revokes the
session family. `Idempotency-Key` is mandatory for merge confirmation and
deletion creation and is scoped to the authenticated account.

## OAuth callback allowlist

Browser authorization creates a one-time, ten-minute transaction bound to the
provider, `state`, server-generated `nonce`, PKCE S256 challenge, intent, and
one exact redirect URI from deployment configuration `XMCL_OAUTH_REDIRECT_URIS`.
The exchange must present the same transaction, provider, state, and verifier.
Callback URIs are never reflected unless they were allowlisted. Launcher
exchange is distinct: it accepts only a fresh, one-time launcher login
transaction and immediately discards the provider credential after server-side
validation.

## Merge reauthentication

An identity conflict never exposes the other account. Merge preparation requires
an active destination XMCL session plus fresh verification of an identity owned
by the source account. Confirmation requires `confirmed: true` and an
idempotency key. The proposed merge event contains account IDs and identity
provider only—never an OAuth credential, subject, email, or display name.
