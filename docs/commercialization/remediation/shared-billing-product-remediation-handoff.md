# Remediation Handoff: Shared Billing, Operations, and Product UI

## Scope

Own shared-hosting financial lifecycle, operational enforcement, and product UI.

API/billing files:

- `src/lib/sharedHosting.ts`
- `src/lib/sharedHostingScheduler.ts`
- `src/lib/sharedHostingScheduling.ts`
- `src/lib/billing.ts`
- `src/lib/billingRuntime.ts`
- `src/lib/paypal.ts`
- billing/admin routes and Cloudflare scheduled wiring

Website files belong in:

```text
C:\Users\ci010-4090\Workspace\xmcl-page
```

Do not change node command authentication, Docker execution, or Vultr
provisioning in this package.

## Required fixes

### 1. Add periodic shared runtime settlement

Current code charges one runtime hour on successful start and charges remaining
whole hours only when the service stops. A service that runs continuously is
therefore not billed after its first hour.

Implement a trusted scheduled job that:

- finds every running shared service;
- settles each newly elapsed whole hour using immutable plan rates:
  - Small: rate version 101, $0.06/hour;
  - Medium: rate version 102, $0.09/hour;
  - Large: rate version 103, $0.12/hour;
- stores the durable settled-hour watermark atomically with the charge;
- uses service ID, assignment ID, and hour number as idempotency identity;
- never accepts a price or rate version from node agents.

### 2. Enforce payment due for running services

When runtime settlement or monthly renewal changes a subscription to
`payment_due`:

1. prevent new starts;
2. enqueue a trusted stop/sync command for every currently running/starting
   service under that subscription;
3. preserve canonical workspace data;
4. show the user a payment-due state and recovery action;
5. do not delete data before the documented grace period.

### 3. Fix PayPal external I/O transaction safety

Current `BillingService.createOrder` calls PayPal while holding the durable
Mongo billing-state lease. If PayPal succeeds but the local commit fails, retry
can create another provider order.

Implement a recoverable two-phase order flow:

1. atomically persist an idempotency claim and pending local order before
   provider I/O;
2. call PayPal outside the global billing lease;
3. atomically finalize local order with provider order ID/approval URL;
4. reconcile a pending order on retry rather than creating a duplicate;
5. only credit from a verified webhook.

Do not expose public PayPal routes until this flow, real signature verification,
and operational reconciliation are complete.

### 4. Complete storage quota operations

Use canonical object-storage workspace size from the node sync report.

- Small quota: 32GiB; Medium: 48GiB; Large: 64GiB.
- Notify at overage detection.
- Preserve a seven-day grace period.
- After grace, block new starts and surface remediation; do not auto-delete
  canonical data.
- Add administrator reconciliation for logical bytes, physical retained bytes,
  grace deadline, and subscription status.

### 5. Implement product UI after API readiness

`xmcl-page` currently has no shared-hosting UI.

Add plan/subscription/service screens only after real production composition is
enabled. The UI must show:

- Small/Medium/Large plan quotas and base/hour prices from API data;
- upfront first-month base fee confirmation;
- `ready`, `queued`, `starting`, `running`, `stopping`, `failed`, and
  `payment_due` states;
- capacity wait/cold-start explanation;
- workspace size, overage grace, and cancel-at-period-end state.

Never expose node IDs, object prefixes, S3 credentials, Docker state, Vultr
instance IDs, assignment IDs, or raw internal errors.

## Required tests

1. A service running 5 hours is charged exactly five hourly rates, including
   after scheduler retry/restart.
2. Repeated periodic ticks do not double charge any hour.
3. Runtime payment failure enqueues one stop/sync and blocks later start.
4. Monthly renewal payment failure applies the same enforcement.
5. PayPal provider success plus local finalize failure reconciles to one
   provider order on retry.
6. Verified webhook credits exactly once.
7. Storage overage blocks start only after grace and never deletes canonical
   data.
8. UI renders queued/payment-due without leaking internal node/storage details.

## Acceptance

Demonstrate a full test flow:

```text
credit -> subscribe -> create service -> run five hours -> five exact charges
-> insufficient balance -> stop/sync -> payment due -> recharge -> restart
```

The final production composition must still fail closed if PayPal, scheduler,
node transport, or storage reporting dependencies are absent.
