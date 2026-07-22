# M7 compliance and operations publication proposal v1

This module-local proposal is submitted to the shared contract owner. It does
not modify `contracts/`.

## Published boundary proposed

- `openapi.yaml` describes only mounted `/v1/admin/*` endpoints. They require
  an independently verified MFA admin principal; normal XMCL user sessions are
  not accepted.
- `audit-event.schema.json` describes the sanitized audit-read model.
- `operation-response.schema.json` describes the asynchronous accepted-command
  response and operation status model.
- `fixtures/` covers authentication/permission failures, operation-id replay,
  absent M3/M4 owner adapters, and audit metadata sanitization.

## Shared-v1 consumption

M7 publishes and consumes the existing D6 event schemas by reference:

- `../../contracts/shared/v1/admin-operation-requested.schema.json`
- `../../contracts/shared/v1/admin-operation-completed.schema.json`

It does not duplicate or redefine these event schemas. M3 handles only
`refund` and `balance_adjust`; M4 handles only `server_suspend` and
`server_restore`. Each owner deduplicates `operationId` and emits one D6
completion.

No public user-support endpoint is proposed here: the current support form is
an M7-local draft consumer until a separately versioned user-support API is
published. It never calls an admin endpoint.
