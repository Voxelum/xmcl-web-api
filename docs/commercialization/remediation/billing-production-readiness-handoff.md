# Billing production-readiness handoff

## Scope

Work only in:

```text
C:\Users\ci010-4090\Workspace\xmcl-web-api
```

Own payment recovery and scheduled billing-work internals:

- `src/lib/billing.ts`
- `src/lib/paypal.ts`
- `src/lib/billingRuntime.ts`
- `src/lib/sharedHostingScheduling.ts`
- targeted billing/PayPal/runtime tests and direct operations documentation.

Do not modify shared-node transport, workspace grants, modded runtime/compiler,
Vultr provisioning, public shared-hosting routes, website UI, or
`cloudflare/worker.ts`. Another agent owns the modded runtime work and may
modify shared runtime tests.

## Current state

Implemented and correct:

- `MongoBillingStore` persists one versioned billing aggregate with a
  lease/CAS write boundary.
- `BillingService.createOrder` persists a pending intent before provider I/O,
  calls PayPal outside the billing lease, and atomically finalizes a result.
- A duplicate idempotency key reuses the same local order/provider request ID.
- Shared subscriptions charge base fee, renew monthly, and runtime settlement
  can transition payment-due services to stop/sync.

Missing for live production:

1. An abandoned pending PayPal intent is retried only when its original client
   retries. There is no trusted scheduled reconciliation operation.
2. Runtime settlement must execute hourly; code owns the operation but no
   explicit hourly production-work contract is exposed for the platform entry.
3. Public payment routes remain intentionally disabled and must stay disabled
   in this package.

## Required implementation

### 1. Durable PayPal pending-order reconciliation

Add a trusted, idempotent reconciliation work interface exposed from
`BillingRuntime`, such as:

```ts
interface BillingReconciliationWork {
  reconcilePendingPayPalOrders(at: Date, limit?: number): Promise<{
    attempted: string[];
    finalized: string[];
    stillPending: string[];
    failed: string[];
  }>;
}
```

Requirements:

- It operates only on persisted pending orders that lack a provider order ID
  and whose provider creation attempt is stale.
- It uses the original local `orderId` as the stable PayPal request identity.
  The provider must call PayPal with the same idempotency header/request ID,
  never generate a second provider order.
- Provider I/O remains outside any `BillingStore.transaction` callback.
- After a provider response, local finalization must compare the current
  attempt/order identity and remain idempotent under concurrent scheduled/client
  recovery.
- If PayPal is unavailable, preserve a recoverable pending state and record a
  typed/sanitized failure outcome; do not credit balances, mark completion, or
  lose the intent.
- Do not scan or log raw payment data, credentials, approval URLs, webhook
  headers, or user-provided bodies.
- Bound work by a safe limit and deterministic order. Existing aggregate
  persistence may require a read projection to identify candidates; retain
  aggregate consistency and do not introduce a broad unbounded Mongo scan.

### 2. Explicit hourly shared runtime settlement work

Add a runtime-owned scheduler interface that combines:

- shared subscription renewals;
- hourly running-service settlement;
- payment-due stop/sync dispatch;
- pending PayPal reconciliation.

The interface must be valid for a future platform cron caller but must not
mount public payment/shared routes or directly edit `cloudflare/worker.ts`.
It must safely catch up missed hourly invocations using elapsed runtime
watermarks and remain idempotent when called twice for the same hour.

Document that the deployment cron must be hourly or more frequent. The current
daily trigger is insufficient because it could delay `payment_due` enforcement
by nearly a day.

### 3. PayPal provider contract

Ensure `PayPalHttpProvider` uses PayPal's supported idempotency header for
order creation with the stable local order ID. The reconciliation flow must
reuse the exact same request identity.

Keep webhook verification and capture behavior strict. Do not enable routes
from this package; production composition will be changed only after sandbox
and live webhook verification are completed.

## Tests

Add targeted tests proving:

1. A stale pending order is reconciled using its original provider request ID,
   outside the Mongo lease, and ends with exactly one local/provider order.
2. Concurrent client retry and scheduler reconciliation cannot create two
   provider orders or credit twice.
3. Provider failure leaves the order safely pending/recoverable and does not
   change cash balance.
4. Scheduled reconciliation honors a bound/limit and stable candidate ordering.
5. An hourly shared settlement catches up elapsed hours exactly once and
   dispatches payment-due stop/sync.
6. Re-running the same scheduled work is idempotent.
7. Existing payment/public production route gates remain off.

Run focused Deno tests and `deno check` for modified files.

## Deliverable

Report:

- changed source/tests/docs;
- exact test results;
- provider secrets/webhook/sandbox setup still required;
- the required platform cron cadence;
- confirmation that public payment routes remain disabled.
