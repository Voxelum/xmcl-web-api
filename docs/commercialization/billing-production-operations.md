# Billing production operations

## Trusted hourly work

The platform cron must invoke the trusted
`SharedRuntimeSettlementWork.runHourly` operation **hourly or more frequently**.
Daily scheduling is not sufficient: runtime settlement and `payment_due`
stop/sync enforcement could otherwise be delayed by almost 24 hours. The
operation safely catches up elapsed whole hours from durable service and billing
watermarks, and repeated calls for the same hour are idempotent.

The cron composition must provide:

- the shared subscription renewal service;
- the shared runtime scheduler, including durable stop/sync dispatch;
- `BillingReconciliationWork` backed by `PayPalService` for bounded pending
  order recovery.

Use the default reconciliation limit (25) or an explicitly positive limit no
greater than 100. Candidates are ordered by stale attempt time then local order
ID. Do not log provider response bodies, approval URLs, webhook headers, or
payment request bodies.

## Azure `xmcl-shared-sgp-control` timer

The isolated `xmcl-shared-sgp-control` Function App registers
`shared-hosting-hourly` with the six-field NCRONTAB expression
`0 0 * * * *` (UTC): once at the start of every hour, not daily. Its monitored
Azure timer uses `AzureWebJobsStorage`; do not disable monitoring or replace
this with an HTTP-triggered/public scheduler.

Every invocation composes a fresh durable shared-hosting runtime from the
current process environment, the Node Mongo connection, and the server-only
S3 SigV4 signer. Configure these app settings before enabling the function:

- `AzureWebJobsStorage`, `MONGO_CONNECION_STRING`, and optionally
  `MONGODB_NAME`;
- `BILLING_RATES_JSON` and optionally `BILLING_CURRENCY`;
- all shared-node settings required by `hasSharedNodeSettings`: `VULTR_API_TOKEN`,
  `VULTR_SHARED_NODE_REGION_ID`, `VULTR_SHARED_NODE_PLAN`,
  `VULTR_SHARED_NODE_IMAGE_ID`, `VULTR_SHARED_NODE_TOTAL_MEMORY_MIB`,
  `VULTR_SHARED_NODE_TOTAL_SHARED_CPU`, `VULTR_SHARED_NODE_TOTAL_WORKSPACE_GIB`,
  `XMCL_SHARED_AGENT_RELEASE_URL`, `XMCL_SHARED_AGENT_RELEASE_SHA256`,
  `XMCL_SHARED_QUOTA_HELPER_RELEASE_URL`,
  `XMCL_SHARED_QUOTA_HELPER_RELEASE_SHA256`, `XMCL_CONTROL_PLANE_URL`,
  `XMCL_VULTR_OBJECT_STORAGE_ENDPOINT`, `XMCL_VULTR_OBJECT_STORAGE_REGION`,
  `XMCL_VULTR_OBJECT_STORAGE_BUCKET`, `XMCL_SHARED_NODE_CONTAINER_IMAGE`,
  `VULTR_SHARED_NODE_BLOCK_STORAGE_GIB`,
  `VULTR_SHARED_NODE_BLOCK_STORAGE_TYPE`,
  `VULTR_SHARED_NODE_FIREWALL_GROUP_ID`,
  `XMCL_SHARED_NODE_INGRESS_PORT_MIN`, and
  `XMCL_SHARED_NODE_INGRESS_PORT_MAX`;
- the server-only `XMCL_VULTR_OBJECT_STORAGE_ACCESS_KEY` and
  `XMCL_VULTR_OBJECT_STORAGE_SECRET_KEY`. Never place either credential in
  route configuration, a node command, or application logs.

The timer renews subscriptions, settles elapsed runtime, dispatches
`payment_due` stop/sync commands, processes bounded capacity requests, and
sweeps node command leases/stale heartbeats. It reconciles at most 25 pending
PayPal orders only when all six PayPal settings below are non-empty; an
incomplete PayPal configuration skips recovery rather than attempting a
provider call.

After deployment, prove cadence by checking Application Insights for one
successful `shared_hosting_hourly_completed` invocation per UTC hour and no
`shared_hosting_hourly_failed` events. The logged context contains only the
event name and invocation timestamp; failures are rethrown for Azure monitoring.

## PayPal deployment prerequisites

Before enabling any public payment or webhook route, configure and verify:

- `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` for the intended sandbox or live
  environment;
- `PAYPAL_WEBHOOK_ID` registered for the exact deployed webhook endpoint;
- `PAYPAL_RETURN_URL` and `PAYPAL_CANCEL_URL` on the approved HTTPS origin;
- `PAYPAL_API_BASE_URL` set to the matching sandbox or live PayPal API;
- an end-to-end sandbox order, capture, signed webhook verification, duplicate
  webhook, and scheduled stale-intent recovery exercise.

PayPal order creation uses the immutable local order ID in the
`PayPal-Request-Id` header. Recovery must retain that identity and only verified
webhooks may credit cash balances.

## Staging-only M3 PayPal Sandbox control plane

### Prerequisite: staging-only M1 browser account/session control plane

The staging Worker cannot reach Cosmos directly. Before M3 can be exercised
with a browser session, it can proxy only this fixed M1 surface to Azure on the
one staging Worker hostname:

- `GET /v1/auth/:provider/authorize` for `microsoft`, `modrinth`, `google`, or
  `discord`, with exactly one each of `redirectUri`, `state`, and
  `codeChallenge` query parameters;
- `POST /v1/auth/:provider/exchange`;
- `GET /v1/account`, `GET /v1/account/identities`, `POST`
  `/v1/account/identities/:provider/authorize`, `POST`
  `/v1/account/identities/:provider/complete`, and `DELETE`
  `/v1/account/identities/:provider`;
- `POST /v1/sessions/refresh` and `POST /v1/sessions/revoke`.

There is no launcher exchange, account merge/deletion, billing, admin,
internal, node, compiler, arbitrary provider, arbitrary URL, or arbitrary
header proxy in this plane. The Worker activates it only at:

```text
https://xmcl-web-api-shared-sgp-staging.cijhn.workers.dev
```

It rejects every other hostname and does not construct its Hono application or
open/import its Mongo connector for an M1 proxy or preflight request.

The routes are absent unless every setting below is present and valid. This
change does **not** set settings or deploy either service.

**Azure Function App** settings on `xmcl-shared-sgp-control`:

- `XMCL_STAGING_ACCOUNT_PROXY_ENABLED=true` exactly; `TRUE`, `1`, or an absent
  value leaves all M1 routes unmounted.
- `MONGO_CONNECION_STRING`, optional `MONGODB_NAME`, and
  `XMCL_SESSION_SECRET` with at least 32 UTF-8 bytes for the existing Azure
  Mongo/Cosmos account runtime.
- Complete browser OAuth settings for every fixed supported provider:
  `XMCL_MICROSOFT_CLIENT_ID`, `XMCL_MICROSOFT_CLIENT_SECRET`,
  `XMCL_MODRINTH_CLIENT_ID`, `XMCL_MODRINTH_CLIENT_SECRET`,
  `XMCL_GOOGLE_CLIENT_ID`, `XMCL_GOOGLE_CLIENT_SECRET`,
  `XMCL_DISCORD_CLIENT_ID`, and `XMCL_DISCORD_CLIENT_SECRET`.
- `XMCL_STAGING_ACCOUNT_PROXY_CORS_ORIGINS=https://<staging-pages-origin>`
  (comma-separate further exact Pages origins only). Values are HTTPS origins
  with no trailing slash, path, query, fragment, wildcard, or credentials.
- `XMCL_OAUTH_REDIRECT_URIS` must include
  `https://<staging-pages-origin>/oauth/callback` for **every** configured M1
  CORS origin. It may contain other reviewed callbacks, but does not make them
  proxyable from this Worker.
- `XMCL_STAGING_ACCOUNT_PROXY_KEY_ID=<new M1 key ID>` matching
  `[A-Za-z0-9][A-Za-z0-9._-]{0,127}` and
  `XMCL_STAGING_ACCOUNT_PROXY_SECRET=<new random server-only secret of at
  least 32 UTF-8 bytes>`.

**Cloudflare Worker secrets/configuration** on the existing staging Worker
only:

- `XMCL_STAGING_ACCOUNT_PROXY_ENABLED=true`;
- `XMCL_STAGING_ACCOUNT_PROXY_URL=https://xmcl-shared-sgp-control.azurewebsites.net/api`
  exactly (HTTPS, no credentials/query/fragment, path exactly `/api`);
- matching `XMCL_STAGING_ACCOUNT_PROXY_KEY_ID` and
  `XMCL_STAGING_ACCOUNT_PROXY_SECRET`;
- `XMCL_STAGING_ACCOUNT_PROXY_CORS_ORIGINS` exactly matching Azure.

Use a new M1 key ID and secret. They must differ from both
`XMCL_STAGING_M3_PROXY_KEY_ID`/`XMCL_STAGING_M3_PROXY_SECRET` and
`XMCL_PAYPAL_WEBHOOK_PROXY_KEY_ID`/`XMCL_PAYPAL_WEBHOOK_PROXY_SECRET`; the
composition rejects an equality when the other configured identity is present.

Register the exact Pages callback in the Microsoft, Modrinth, Google, and
Discord provider dashboards:

```text
https://<staging-pages-origin>/oauth/callback
```

This is the provider redirect URI, not the Worker URL. The Pages callback must
retain the provider `code` and the browser's state/PKCE verifier, then call the
allowlisted Worker exchange route. The Worker validates the authorize query,
preserves its original encoding in the Azure target, signs that exact
`/api/...` target plus raw bytes with a fresh timestamp/nonce, and forwards
only `Authorization`, `content-type`, and the configured exact `Origin`.
Azure requires the same target, HMAC, ±60 second timestamp, and a durably
consumed Cosmos Mongo nonce before running the existing account/session
handler. Both proxy hops reject redirects, bound request/response sizes, and
return sanitized failures.

M3 exposes only these authenticated Sandbox routes through the existing staging
Worker to Azure:

- `POST /v1/billing/paypal/orders`;
- `POST /v1/billing/paypal/orders/:orderId/capture`;
- `GET /v1/billing/balance`, `/v1/billing/rates`, `/v1/billing/ledger`, and
  `/v1/billing/usage`.

There is no balance-credit API. Only the separately verified PayPal webhook can
credit the durable ledger. The Worker rejects query strings for every M3 route:
none has reviewed pagination semantics yet.

The routes are absent by default. After review and deployment, set all of these
**Azure Function App** settings on `xmcl-shared-sgp-control`:

- `XMCL_STAGING_M3_CHECKOUT_ENABLED=true` exactly. Any other value, including
  `TRUE`, leaves every M3 route unmounted.
- `MONGO_CONNECION_STRING`, optional `MONGODB_NAME`, and a valid JSON-array
  `BILLING_RATES_JSON` for the reachable Cosmos Mongo account.
- Sandbox `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and `PAYPAL_WEBHOOK_ID`;
  HTTPS `PAYPAL_RETURN_URL` and `PAYPAL_CANCEL_URL` without credentials or
  fragments; and
  `PAYPAL_API_BASE_URL=https://api-m.sandbox.paypal.com` exactly. A live or
  alternate PayPal base never mounts M3.
- `XMCL_STAGING_M3_PROXY_KEY_ID=staging-m3-worker-v1` (or a different
  documented ID matching `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`) and
  `XMCL_STAGING_M3_PROXY_SECRET=<new random server-only secret of at least 32
  UTF-8 bytes>`.
- `XMCL_STAGING_M3_CORS_ORIGINS=https://staging.launcher.example` (comma
  separate additional exact HTTPS origins). Entries must be origins only:
  no trailing slash, path, query, fragment, wildcard, or credentials.

Set these **Cloudflare Worker secrets/configuration values** on the existing
staging Worker only; do not put secrets in source control:

- `XMCL_STAGING_M3_PROXY_URL=https://xmcl-shared-sgp-control.azurewebsites.net/api`
  exactly: HTTPS, no credentials/query/fragment, and path exactly `/api`;
- `XMCL_STAGING_M3_PROXY_KEY_ID=staging-m3-worker-v1`, matching Azure;
- `XMCL_STAGING_M3_PROXY_SECRET=<the same new random secret>`;
- `XMCL_STAGING_M3_CORS_ORIGINS` exactly matching the Azure origin list.

This M3 HMAC identity and secret are distinct from the existing webhook identity.
For the webhook, retain these separate settings:

- Azure: `XMCL_PAYPAL_WEBHOOK_PROXY_KEY_ID`,
  `XMCL_PAYPAL_WEBHOOK_PROXY_SECRET`;
- staging Worker: `PAYPAL_WEBHOOK_PROXY_URL=https://xmcl-shared-sgp-control.azurewebsites.net/api/v1/webhooks/paypal`,
  `XMCL_PAYPAL_WEBHOOK_PROXY_KEY_ID`, and
  `XMCL_PAYPAL_WEBHOOK_PROXY_SECRET`.

Register this exact PayPal **Sandbox** webhook URL, not the Azure URL:

```text
https://xmcl-web-api-shared-sgp-staging.cijhn.workers.dev/v1/webhooks/paypal
```

The Worker activates only on that staging hostname. It constructs fixed Azure
`/api` targets from the allowlist, forwards only `Authorization`,
`idempotency-key`, `content-type`, and the validated browser `Origin`, and signs
the original raw bytes. It never imports or opens its Mongo connector on proxy
or preflight paths. Azure requires the original `/api/...` target, a fresh
durably consumed Mongo nonce, and the normal Bearer account session before
billing logic. It does not proxy admin, internal, node, compiler, arbitrary
methods, URLs, or headers.

### Sandbox end-to-end test sequence

#### Obtain the M1 staging user session first

1. From one configured staging Pages origin, generate a PKCE verifier/challenge
   and state. Call `GET /v1/auth/<provider>/authorize` on the Worker with
   `redirectUri=https://<staging-pages-origin>/oauth/callback`, the state, and
   the challenge. Confirm the returned provider authorization URL retains the
   state and PKCE challenge and has that exact Pages `redirect_uri`.
2. Complete provider sign-in. At `/oauth/callback`, verify state locally and
   call `POST /v1/auth/<provider>/exchange` on the Worker with `transactionId`,
   provider code, state, and verifier. Save the returned XMCL access and
   refresh tokens.
3. Call `GET /v1/account` and `GET /v1/account/identities` through the Worker
   with the access token to confirm the authenticated M1 session. Exercise
   `POST /v1/sessions/refresh` once to verify token rotation.
4. Confirm an unconfigured Origin, missing/duplicate authorize parameter,
   query on any non-authorize M1 route, wrong method, provider outside the
   fixed list, launcher/merge/deletion path, direct Azure call without M1 HMAC,
   stale timestamp, replayed nonce, changed raw body, and substituted
   `/api/...` target all fail without invoking account authentication.

#### Continue with the M3 checkout using that M1 access token

1. After the reviewed deployment, obtain a staging user Bearer session and call
   `GET /v1/billing/balance` and `GET /v1/billing/rates` through the Worker.
   Browser calls must use one configured `Origin`; an unconfigured origin,
   query string, wrong method, or extra path must return `404`.
2. Create a Sandbox order through the Worker with `Authorization`,
   `content-type: application/json`, and a stable `idempotency-key`. Repeat the
   identical request and confirm the durable order is replayed rather than
   duplicated. Complete approval in the Sandbox buyer flow, then call the
   allowlisted capture route (continue sending an idempotency key).
3. Confirm `GET /v1/billing/ledger` and `GET /v1/billing/usage` are scoped to
   the authenticated account. Do not attempt a direct credit.
4. Send a Sandbox webhook, its duplicate, and an invalid-signature delivery to
   the Worker URL above. Confirm the duplicate is safe and the invalid delivery
   cannot affect the ledger.
5. Verify direct Azure requests without the staging M3 HMAC, altered bodies,
   stale timestamps, replayed nonces, target swaps, redirects, and oversized
   responses produce only sanitized failures.

Check only sanitized status/error metadata in logs; never log request bodies,
credentials, Bearer tokens, HMAC headers, or PayPal signature headers. This
change does not configure settings or deploy either service.

## Route status

Public payment and shared-hosting routes remain disabled in production
composition. This package provides trusted work interfaces only; enabling routes
requires the separate production-composition decision after the prerequisites
above are complete.
