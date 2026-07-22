# Local demo

> **Local demo only — never deploy this profile.** It starts a loopback-only HTTP
> server with process-local state and public mock credentials. Stopping the
> process discards all data.

This profile is intentionally separate from the normal `start` command and
does not use production composition. It never constructs or reads credentials
for PayPal, Vultr, an AI provider, object storage, MongoDB, or OAuth providers.

## Prerequisites and start commands (Windows PowerShell)

Install [Deno](https://docs.deno.com/runtime/) and run from this repository:

```powershell
deno task local-demo
```

The server listens only on `http://127.0.0.1:8787`. Choose another port with:

```powershell
$env:PORT = "8790"
deno task local-demo
```

The only local-demo environment variable is:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Integer TCP port from `1` through `65535`. |

Do **not** set service credentials for this command; they are neither needed
nor consumed. `GET /__local-demo` returns `profile: "xmcl-local-demo"` and is
an intentional, unmistakable confirmation that this is the demo process.

## Demo credentials

These values are deliberately public and accepted **only** by the local demo:

| Role | Credential | Use |
| --- | --- | --- |
| User | `Bearer demo-user-token` | User, billing, server, backup, AI, and modpack routes. |
| User refresh | session `demo-user-session`, refresh token `demo-user-refresh-token` | `POST /v1/sessions/refresh`. |
| Internal service | `Bearer demo-service-token` | Internal usage authorization, release, and settlement routes. |
| Administrator | `Bearer demo-admin-token` | `/v1/admin/*`; it has the local administrator permission and fresh MFA. |
| Worker bootstrap | `demo-worker-bootstrap` | Signed `Worker-Bootstrap` registration for `demo-server` / `demo-lease`. |
| Restore worker | `Bearer demo-restore-worker-token` | World-backup restore events for the demo server. |

The pre-created user account is `demo-user`. The running demo server is
`demo-server`; its active lease is `demo-lease`. Tokens are deterministic so
scripts can use them, but they are **not passwords, secrets, or valid outside
this process**.

## Route families and authorization

All domain routes below are mounted in local demo. Standard user routes require
the user token and enforce their normal scopes. The demo user has
`account:read`, `account:write`, `session:manage`, `ai:invoke`,
`modpack:read`, and `modpack:write`. Server reads/controls are authorized by
the existing account read/write compatibility rules.

| Family | Routes | Auth / expected behavior |
| --- | --- | --- |
| Profile | `GET /__local-demo` | Public. Returns warning, credentials, static server data, and current mock modpack archive hash/size. `Cache-Control: no-store`. |
| Account and sessions | `/v1/account`, `/v1/account/identities`, `/v1/auth/*`, `/v1/sessions/*` | User token except the OAuth initiate/exchange endpoints. OAuth is a deterministic local mock; no identity provider is contacted. |
| Backup storage policy | `GET /v1/backup-storage-policy` | User token. Returns the current 1 GiB free policy. |
| World backups | `/v1/backup-sources/*/backups`, `/v1/world-backups/*`, `/v1/internal/world-backups/*/events` | User token for customer operations; restore-worker token for callback events. Create/write routes require `Idempotency-Key`. |
| Billing and payments | `/v1/billing/*`, `/v1/billing/paypal/*`, `/v1/webhooks/paypal` | User token for customer routes. PayPal webhook is intentionally unauthenticated but its mock verifier accepts the supplied payload. Payment creation requires `Idempotency-Key`. |
| Internal usage | `/v1/internal/usage/{authorize,release,settle}` | Internal service token with `billing:internal`. Authorization and settlement validate body/header idempotency keys. |
| Servers and tasks | `/v1/servers`, `/v1/tasks/*` | User token. Mutations require `Idempotency-Key`; repeated equal requests return the stored task and changed payloads return `409 idempotency_conflict`. |
| Worker callbacks | `/v1/internal/servers/:serverId/worker/*` | Register with the bootstrap credential plus HMAC headers; subsequent requests use the issued `Worker` token and fresh signed nonce. |
| AI | `/v1/ai/models`, `/v1/ai/:capability` | User token with `ai:invoke`. The `troubleshoot` capability uses the `local-demo-small` deterministic provider and requires `Idempotency-Key`. `GET /v1/ai/usage` is intentionally excluded because that route has no usage-projection adapter; it returns `503 ai_usage_not_configured`. |
| Modpack deployment | `/v1/servers/*/modpack-imports`, `/v1/modpack-imports/*`, `/v1/modpack-deployments/*`, `/v1/modpack-tasks/*` | User token with `modpack:read` or `modpack:write`. The profile response supplies the required archive metadata. |
| Administration | `/v1/admin/*` | Admin token only. Audit, metrics, reconciliation, account reads, and command requests use in-memory adapters. |

`GET /` and `GET /flights` are also safe, dependency-free smoke targets.

## Request examples

Set helpers in PowerShell:

```powershell
$base = "http://127.0.0.1:8787"
$user = @{ Authorization = "Bearer demo-user-token"; "Content-Type" = "application/json" }
```

Read the profile and account:

```powershell
Invoke-RestMethod "$base/__local-demo"
Invoke-RestMethod "$base/v1/account" -Headers $user
```

Expected results are `200`; `/v1/account` returns `accountId: "demo-user"`.
Omitting `Authorization` returns `401 authentication_required`.

Create a server and retry it with the same idempotency key:

```powershell
$serverHeaders = $user.Clone()
$serverHeaders["Idempotency-Key"] = "example-server-create"
$body = @{ plan = "vc2-2c-4gb" } | ConvertTo-Json
Invoke-RestMethod "$base/v1/servers" -Method Post -Headers $serverHeaders -Body $body
Invoke-RestMethod "$base/v1/servers" -Method Post -Headers $serverHeaders -Body $body
```

Both calls return `202` and the same queued task. Reusing
`example-server-create` with `{ "plan": "vc2-4c-8gb" }` returns
`409 idempotency_conflict`.

Create a small world backup:

```powershell
$backupHeaders = $user.Clone()
$backupHeaders["Idempotency-Key"] = "example-backup"
$backup = @{
  worldId = "example-world"; format = "linear"; formatVersion = 1
  contentLength = 128; sha256 = ("a" * 64)
  contentType = "application/vnd.xmcl.linear"; compression = "xmcl_linear"
  explicitManual = $true
} | ConvertTo-Json
Invoke-RestMethod "$base/v1/backup-sources/client_world/example-world/backups" `
  -Method Post -Headers $backupHeaders -Body $backup
```

This returns `202` with `backupId` and `taskId`; retrying returns the same
resource. Issue `POST /v1/world-backups/{backupId}/upload-url`, then
`POST /v1/world-backups/{backupId}/complete`, each with an idempotency key, to
receive `200` and `202` respectively.

Invoke the deterministic AI mock:

```powershell
$aiHeaders = $user.Clone()
$aiHeaders["Idempotency-Key"] = "example-ai"
Invoke-RestMethod "$base/v1/ai/troubleshoot" -Method Post -Headers $aiHeaders `
  -Body (@{ input = "The launcher stopped." } | ConvertTo-Json)
```

It returns `200` and an output beginning `Local demo response:`. An empty
input returns `400 invalid_ai_request`; a changed retry using the same
idempotency key returns `409`.

For modpack imports, first read `modpackArchive.sha256` and
`modpackArchive.sizeBytes` from `/__local-demo` and use those exact values in
the import request. The local mock automatically accepts its archive when the
upload URL is created; completing the import runs validation synchronously.

## Mock boundaries and excluded APIs

- Payment order, capture, and webhook behavior use an in-memory provider and
  verifier. No PayPal endpoint or credential is reachable.
- Server operations use an in-memory provider adapter; no Vultr API call or
  token is possible.
- AI returns a deterministic string and settles against an in-memory ledger;
  no model/provider request is made.
- Backup and modpack upload URLs use the `mock://` scheme. The corresponding
  object/archive is accepted in memory when the URL is issued; no object
  storage request occurs.
- OAuth URLs and exchanges are local deterministic mocks.
- `GET /v1/ai/usage` is intentionally unavailable (`503
  ai_usage_not_configured`) because the route does not yet define a
  usage-projection adapter.
- The following legacy routes are intentionally outside local-demo coverage and
  must not be used as a local substitute for their platform integration tests:
  `/latest`, `/releases/:filename`, `/notifications`, `/translation`,
  `/group/:id`, `/rtc/*`, `/zulu`, `/elyby/authlib`, `/modrinth/auth`,
  `/kook-badge`, `/appx`, `/appinstaller`, and `/prebuilds`. Their original
  handlers can depend on MongoDB, GitHub, translation/release mirrors,
  WebRTC/TURN, or WebSocket platform services. A Mongo-backed request fails
  explicitly rather than connecting to a database.

## Production safety

`createProductionApp` remains the production entry-point composition. Its
commercial routes remain unmounted unless durable adapters exist, and setting
`XMCL_COMMERCIAL_ENABLED=true` still stops startup with its configuration
error. The `local-demo` task does not invoke that composition and binds only
to loopback. Never expose its port or copy its public mock credentials into a
deployment.

## Smoke test

Run the complete HTTP smoke test, which starts an ephemeral local-demo server:

```powershell
deno task local-demo:smoke
```

To test an already-running local demo instead, verify its profile and run:

```powershell
$env:DEMO_BASE_URL = "http://127.0.0.1:8787"
deno task local-demo:smoke
```

The smoke test covers public-safe routes, account/session, backup policy,
billing/payment/webhook, internal usage, server idempotency, world backups,
AI idempotency plus the intentional usage-projection `503`, worker
registration/heartbeat, modpack validation/deployment, and admin routes.
