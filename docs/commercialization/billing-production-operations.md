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
