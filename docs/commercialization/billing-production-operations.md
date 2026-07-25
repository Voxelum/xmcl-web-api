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

## Route status

Public payment and shared-hosting routes remain disabled in production
composition. This package provides trusted work interfaces only; enabling routes
requires the separate production-composition decision after the prerequisites
above are complete.
