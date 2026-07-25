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

## Staging-only PayPal Sandbox webhook proxy

The staging webhook does **not** enable public PayPal orders, capture, balance,
or ledger routes. PayPal Sandbox must call the nonproduction Cloudflare Worker,
which forwards only the fixed webhook POST to Azure. The Worker never opens a
Mongo connection for that proxy request; Azure owns raw-body signature
verification and the durable Mongo ledger operation.

After this change is reviewed and deployed, set these **Azure Function App**
settings on `xmcl-shared-sgp-control`:

- `MONGO_CONNECION_STRING`, optional `MONGODB_NAME`, and a valid
  `BILLING_RATES_JSON` for the reachable Cosmos Mongo account;
- `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and `PAYPAL_WEBHOOK_ID` from the
  PayPal Sandbox app;
- `PAYPAL_API_BASE_URL=https://api-m.sandbox.paypal.com` exactly (the Azure
  webhook route is intentionally not mounted for a live or other API base);
- `XMCL_PAYPAL_WEBHOOK_PROXY_KEY_ID=paypal-worker-staging-v1` (or another
  documented key ID matching `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`);
- `XMCL_PAYPAL_WEBHOOK_PROXY_SECRET=<new random server-only secret of at least
  32 UTF-8 bytes>`.

Set these **Cloudflare Worker secrets** on the staging Worker only; do not put
them in `[vars]` or source control:

- `PAYPAL_WEBHOOK_PROXY_URL=https://xmcl-shared-sgp-control.azurewebsites.net/api/v1/webhooks/paypal`;
- `XMCL_PAYPAL_WEBHOOK_PROXY_KEY_ID=paypal-worker-staging-v1`, exactly matching
  Azure;
- `XMCL_PAYPAL_WEBHOOK_PROXY_SECRET=<the same new random secret>`.

Register this exact PayPal **Sandbox** webhook URL, formed from the existing
staging Worker origin and the one proxy path:

```text
https://xmcl-web-api-shared-sgp-staging.cijhn.workers.dev/v1/webhooks/paypal
```

Do not register the Azure URL with PayPal. Do not add a query string, credentials
or a fragment to `PAYPAL_WEBHOOK_PROXY_URL`; the Worker rejects those values and
requires the exact `/api/v1/webhooks/paypal` target. The proxy also activates
only for the staging Worker hostname shown above. It forwards only
`content-type`, PayPal signature/request headers, and its HMAC identity. Azure
requires a fresh signed `POST /api/v1/webhooks/paypal`, rejects nonce replays in
Mongo, and verifies the PayPal signature before touching the ledger.

Validate with a Sandbox delivery, a duplicate delivery, and a deliberately
invalid signature. Check only sanitized status/error metadata in logs; never log
webhook bodies, credentials, HMAC headers, or PayPal signature headers. This
change does not deploy either service or set any real credentials.

## Route status

Public payment and shared-hosting routes remain disabled in production
composition. This package provides trusted work interfaces only; enabling routes
requires the separate production-composition decision after the prerequisites
above are complete.
