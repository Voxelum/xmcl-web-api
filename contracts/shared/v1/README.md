# Commercialization shared contracts v1

These contracts are the published boundary for M1-M9. Module proposals may
adapt to this version, but no module may change these files without a new
version.

## D1 and D4: backup storage accounting

M2 owns only `BackupStoragePolicyV1`, whose `freeBytes` is exactly
`1_073_741_824`. M6 is the sole writer of `StorageAccountingV1`, including
`usedBytes`, `overageBytes`, physical object ownership, reference counts, and
`lastSettledAt`.

`GET /v1/backup-storage-policy` is the session-authenticated, read-only
consumer endpoint for this policy. It returns policy data only; M6 exposes any
account-specific storage accounting separately.

Only a verified object with one or more active references counts toward
storage. A physical object has one immutable `storageOwnerAccountId`; a
reference from another account is rejected. Thus a shared layer is charged
once to its owner, never once per reference. `usedBytes` is the sum of distinct
counted physical objects and `overageBytes = max(usedBytes - freeBytes, 0)`.

The storage settlement interval is 3,600 seconds, aligned to Unix epoch
boundaries. `lastSettledAt` is the exclusive lower bound of the next interval.
Before any mutation that changes counted bytes, references, or attribution, M6
settles `[lastSettledAt, mutation.occurredAt)` with the old state. It then
applies the mutation and advances the cursor atomically with the usage outbox.

## D2 and D3: authorization and canonical usage

M3 is the sole writer of balances, reservations, authorizations, rates,
settlements, and ledger entries. A producer must obtain an authorization before
incurring billable usage, and every canonical usage event binds that
authorization, source, rate version, and idempotency key. The event ID and
idempotency key deduplicate exact retries; a reused key with a different
payload is a conflict. Producers that need ordered billing must supply a
strictly increasing `sequence` per `sourceId`; intervals for a source cannot
overlap.

## D5: balance-exhaustion stop path

For `server_time`, the only path is:

1. M5 publishes canonical usage to M3.
2. M3 returns a settlement result with `action: "stop_required"`.
3. M5 stops Minecraft and publishes `runtime.stopped.v1` with
   `reason: "balance_exhausted"`.
4. M4 closes the lease and transitions the server.

If M4 has not observed `runtime.stopped.v1` within 300 seconds after the
settlement result, it must force-stop the provider resource, close the lease,
and record `worker_unresponsive` as the stop reason.

## D6: administrator commands

M7 publishes `admin.operation.requested.v1`, keyed by `operationId`. M3 only
consumes `refund` and `balance_adjust`; M4 only consumes `server_suspend` and
`server_restore`. The owner records exactly one
`admin.operation.completed.v1` for each accepted operation.
