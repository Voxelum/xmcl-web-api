# Handoff: Shared Hosting Billing and Operations

## Goal

Complete production billing and operational enforcement for shared hosting.

## Existing code

- Durable billing aggregate: `src/lib/ledger.ts`
- Billing runtime: `src/lib/billingRuntime.ts`
- Shared subscriptions: `src/lib/sharedHosting.ts`
- Shared scheduler: `src/lib/sharedHostingScheduler.ts`

Approved shared catalog:

| Plan | Monthly base | Runtime rate | Rate version |
| --- | ---: | ---: | ---: |
| Small | $4 | $0.06/hour | 101 |
| Medium | $6 | $0.09/hour | 102 |
| Large | $8 | $0.12/hour | 103 |

Base fees are already atomically charged when a subscription is created. The
renewal method marks insufficient-balance subscriptions `payment_due`.

## Required delivery

1. Add a trusted scheduler/operations job that calls
   `SharedHostingService.renewDue` at the appropriate UTC calendar-month
   boundary.
2. Settle actual runtime hours for assigned, healthy shared containers against
   `server_time/hour` rate versions `101`, `102`, and `103`.
3. Define hour boundary rules explicitly. Recommended V1: reserve and settle
   one full hour on successful start; additional running time is settled in
   whole-hour increments, never from agent-supplied price.
4. Stop or deny starts for `payment_due` subscriptions. Preserve canonical
   workspace data for the defined grace period.
5. Integrate real PayPal order creation, capture, and signed webhook
   verification before enabling public payments.
6. Define persistent-storage quota measurement and overage/grace behavior from
   the object-storage metrics handoff. V1 measures the canonical synced revision,
   includes the plan quota in the base fee, gives an overage a seven-day
   notification/grace window, blocks new starts after the window, and never
   deletes canonical data automatically.
7. Add admin reconciliation views for subscription state, scheduler assignment,
   workspace size, runtime settlement, and payment state.

## Invariants

- Only the API billing owner decides charge amount and rate version.
- Agent reports duration/health facts, never a dollar amount.
- Each base fee, renewal, authorization, and settlement has an idempotency key.
- A failed payment must not silently leave a service eligible to start.
- Shared runtime charges use the immutable plan rate version. V1 reserves and
  settles one whole hour after a healthy start, then settles additional whole
  hours on stop/sync; the agent never supplies a price.
- Refunds and manual balance changes remain explicit audited admin operations.
- Do not enable public billing routes until real provider verification and
  durable scheduler jobs are deployed.

## Tests required

1. A subscription renewal is charged once under concurrent scheduler ticks.
2. Insufficient renewal balance changes subscription to `payment_due`.
3. `payment_due` service cannot obtain a new runtime assignment.
4. Runtime settlement uses the subscription plan's immutable rate version.
5. Duplicate agent duration reports do not double charge.
6. Cancellation prevents the next renewal but preserves the paid current period.
7. Storage-overage policy does not delete canonical data before documented grace
   and notification workflows.
