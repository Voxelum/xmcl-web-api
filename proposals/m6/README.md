# M6 manual world-backup publication proposal v1

This proposal is owned by M6 and is submitted to the shared-contract owner. It
does not modify `contracts/`.

It consumes `contracts/shared/v1` read-only:

- **D1/D4:** M2 publishes the fixed `BackupStoragePolicyV1`; M6 is the sole
  writer of `StorageAccountingV1`. Only verified, actively referenced physical
  objects count, and each immutable `storageOwnerAccountId` is charged once.
- **D2:** M6 requests an M3 `UsageAuthorizationRequest` before an upload would
  create overage retention.
- **D3:** `storage-retention-usage.event.schema.json` narrows the shared
  canonical usage event to `storage_retention` / `byte_second`, with a stable
  account storage source and ordered, non-overlapping intervals.

The public endpoints require an M1 XMCL session (`account:read` or
`account:write`). The restore-event callback requires a separately injected
worker/service principal with `world_backups:restore`; it is not authenticated
by an XMCL user session.

`openapi.yaml` describes the mounted M6 endpoints. The fixtures cover accepted
creation/upload grants, idempotency/status conflicts, M3 authorization denial,
and unavailable M3/provider adapters.
