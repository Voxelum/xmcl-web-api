# XMCL Web API

This repository contains the server-side code for the X-Minecraft Launcher
(XMCL) web API. It provides various backend services that support the launcher
functionality.

## Overview

The XMCL Web API serves multiple functions:

- Provides launcher update notifications and release information
- Manages real-time communication for multiplayer sessions
- Handles translations for mod descriptions and UI elements
- Offers WebRTC services for peer-to-peer connections
- Supports authentication with various services

## Architecture

The API is built from a **shared [Hono](https://hono.dev) source tree** consumed
by explicit deployment apps. Shared HTTP routes live in [`src/`](src/) and are
registered once in [`src/app.ts`](src/app.ts). Each app owns only its runtime
adapter and deployment configuration.

```
apps/
  api/          primary API Worker, cron/queue handlers, Wrangler config
  ai/           LLM gateway Worker and Wrangler config
  signaling/    RTC Worker, Durable Object, and Wrangler config
  azure/        cold-backup API Function app and host config
  local/        Deno development and in-memory demo servers
src/
  *.ts          shared domain services kept flat without a generic lib layer
  routes/       HTTP route adapters
  middleware/   request middleware
  ai/           AI service composition
  oauth/        OAuth providers and redirect policy
  modpack/      modpack source adapters
  worker/       worker runtime and protocol
  cloudflare/   runtime adapter shared by the three Workers
scripts/        maintenance and migration commands
assets/         repository-hosted static assets
```

Storage uses the native MongoDB driver across Node, local Deno, and Cloudflare
Workers. The application accesses raw collections so existing document shapes
remain unchanged.

### Platform-specific behaviour

| Concern                       | Local Deno                     | Cloudflare Workers                         | Azure Functions            |
| ----------------------------- | ------------------------------ | ------------------------------------------ | -------------------------- |
| HTTP server                   | `Deno.serve(app.fetch)`        | `export default { fetch }`                 | HTTP trigger → `app.fetch` |
| Geo                           | `geoip-country` (forwarded IP) | `request.cf.country` (native)              | `geoip-country`            |
| `/v1/multiplayer/*` WebSocket | not supported                  | Signaling Worker + `MultiplayerRoomObject` | not supported              |
| `/translation`                | Azure/static cache             | Azure/static cache + scheduled refresh     | Azure/static cache         |

Cloudflare intercepts `/v1/multiplayer/rooms/:roomId/socket` upgrades before the
Hono app runs, so CORS middleware never touches the immutable `101` response.

### Production API domains

Production uses three independent Workers. Each entrypoint owns one static route
surface; no Worker dispatches by hostname at runtime:

| Domain               | Mounted surface                                     |
| -------------------- | --------------------------------------------------- |
| `api.xmcl.app`       | API Worker: all core APIs, including `/translation` |
| `ai.xmcl.app`        | `POST /v1/chat/completions` only                    |
| `signaling.xmcl.app` | `/v1/multiplayer/*` and `/v1/rtc/official`          |

The Azure Function mounts the same API surface as `api.xmcl.app` and serves only
as a backup mirror. It does not host AI, signaling, Durable Objects, or cron.

### Staging deployment

The long-lived `staging` branch deploys only
[`apps/waffo-staging`](apps/waffo-staging) to
`https://api-staging.xmcl.app`. The `main` branch continues to deploy the
production API, AI, and signaling Workers. Both workflow paths use matching
GitHub Environments named `staging` and `production`.

The staging Worker fixes `WAFFO_ENVIRONMENT` to `test`; production credentials
must never be attached to that Worker. Waffo private keys, MongoDB connection
strings, object-storage credentials, OAuth settings, and admin identities are
configured independently for each Worker. The website selects only the API
origin and never receives payment-provider secrets. Missing or inconsistent
payment configuration fails closed.

The staging Worker also owns the website OAuth, session, account, and read-only
operations-console routes. Configure provider secrets such as
`XMCL_GOOGLE_CLIENT_SECRET`, `XMCL_DISCORD_CLIENT_SECRET`, and
`XMCL_MODRINTH_CLIENT_SECRET` with `wrangler secret put`; never place them in
`wrangler.toml`. Configure `XMCL_STAGING_ADMIN_ACCESS_TOKEN` as a separate
high-entropy Worker secret. This bearer is accepted only by staging read routes;
admin mutations remain outside the staging public allowlist.

Multiplayer clients use only `/v1/multiplayer/*` on `signaling.xmcl.app`. Rooms
use `master`/`member` roles and revisioned room-state snapshots; no legacy
signaling paths or incremental room events are retained.

### Translation cache pipeline

`GET /translation` never calls Modrinth or CurseForge. The request path
canonicalizes the requested locale and checks the Azure Table dynamic cache,
then the community static cache. Static files use
`<locale>/<type>/<projectId>.json`; the original `<locale>/<projectId>.json`
layout remains a type-checked migration fallback. A hit returns `200` and
records demand in the background. A miss records the same demand synchronously
and returns `202` with `Retry-After: 300`.

Azure Table is partitioned by locale. Each entity uses:

- `PartitionKey = <locale>`
- `RowKey = <type>:<projectId>`

The entity stores the current translation, source hash, request count, refresh
time, failure state, and lease. The source hash is metadata, not part of the
key: changed source replaces the existing translation.

The Cloudflare scheduled handler claims hot/due entities, fetches source with
fixed server-side headers, translates it with Agnes, and overwrites the entity.
Entries with at least 100 accesses refresh every six hours; other entries
refresh daily. Failed jobs retry after one hour. Configure:

- `AZURE_TRANSLATION_TABLE_URL`: complete HTTPS table URL with a SAS query
  granting read, add, update, and query access.
- `AGNES_API_KEYS`: JSON array of translation provider keys.
- `CURSEFORGE_KEY`: required for CurseForge source jobs.
- `TRANSLATION_SCHEDULED_BATCH_LIMIT`: optional, defaults to 10 and caps at 100.
- `TRANSLATION_I18N_BASE`: optional community static-cache base URL.

The checked-in Worker Cron runs every five minutes. The historical Mongo
translation ledger remains only for compatibility with the retired external
workflow and is not used by the request path.

Cloudflare can additionally bind a Workers KV namespace as `TRANSLATION_CACHE`.
KV is only an edge copy of completed content:

1. A request checks KV before Azure Table.
2. A scheduled translation commits Azure Table first, then writes KV.
3. A KV write failure does not roll back the authoritative Table result.
4. A failed KV write advances the Table refresh time so Cron retries in about
   five minutes.

Each KV entry expires ten minutes after its next scheduled Table source refresh.
If propagation fails, the old edge value therefore becomes a miss shortly after
refresh and requests fall back to the newer Table content. Access counts,
leases, failures, and scheduling remain only in Azure Table. Request handling
never writes KV, which prevents an older Table snapshot from racing with and
overwriting a newer scheduled result.

Provision the namespace, then add the returned ID to
`apps/signaling/wrangler.toml`:

```powershell
npx wrangler kv namespace create TRANSLATION_CACHE `
  --config apps/api/wrangler.toml
```

```toml
[[kv_namespaces]]
binding = "TRANSLATION_CACHE"
id = "<namespace id>"
```

#### MongoDB to Azure Table migration

The migration is idempotent, resumable, and dry-run by default. It migrates both
`<locale>_translation` documents and request-only demand from
`translation_requests`. Existing Azure content wins unless overwrite is
explicitly enabled; access counters and timestamps are merged.

```powershell
$env:MONGO_CONNECION_STRING = "mongodb://..."
$env:AZURE_TRANSLATION_TABLE_URL = "https://.../translations?...SAS..."

# Preview inserts/merges without writing.
deno run --allow-net --allow-read --allow-write --allow-env --env `
  scripts/migrate_translations_to_azure_table.ts

# Apply and save a resumable local checkpoint.
$env:TRANSLATION_MIGRATION_APPLY = "1"
deno run --allow-net --allow-read --allow-write --allow-env --env `
  scripts/migrate_translations_to_azure_table.ts

# Compare all valid Mongo keys and demand counters with Azure Table.
deno run --allow-net --allow-env --env `
  scripts/verify_translations_in_azure_table.ts
```

Use `TRANSLATION_MIGRATION_LOCALES=ja,zh-CN` for a canary migration. After the
canary, set `TRANSLATION_MIGRATION_RESET_STATE=1` for the final full/delta pass.
Legacy translations without a provider type are inferred only when the request
ledger identifies exactly one provider; ambiguous records are reported and
skipped rather than assigned to the wrong key.

For cutover, stop the legacy translation worker/request writes, reset and run
one final apply pass, run the verifier, then deploy the Azure-backed request
path. The migration preserves stale content for serving while marking a newer
pending Mongo source version immediately due for retranslation.

## API Endpoints

The default composition serves the following routes (all defined once in
[`src/app.ts`](src/app.ts)); isolated Cloudflare domains mount only their
surface listed above:

- `/latest` - Provides information about the latest launcher releases
- `/releases/:filename` - Access to launcher release files with redirection to
  GitHub
- `/notifications` - System notifications for launcher users from GitHub issues
- `/flights` - Feature flight information for gradual rollouts
- `/translation` - Translation services for mod descriptions (Modrinth and
  CurseForge)
- `/v1/multiplayer/*` - Authenticated multiplayer room creation, admission,
  closure, and Cloudflare Durable Object WebSocket signaling. Joining a valid
  named room with `createIfMissing: true` creates it when absent, and that first
  authenticated user becomes its master.
- `/v1/rtc/official` - WebRTC signaling for peer connections
- `/zulu` - Proxies the Zulu JRE manifest from xmcl-static-resource
- `/elyby/authlib` - Authentication library access
- `/modrinth/auth` - Modrinth authentication integration
- `/kook-badge` - Access to KOOK integration information
- `/appx?version=<v>` - 302 to the Windows `.appx` (geo-aware: `cdn.xmcl.app`
  for mainland China, GitHub otherwise)
- `/appinstaller` - Dynamically-generated `.appinstaller` manifest pointing at
  the latest stable release. Replaces the static
  `xmcl.blob.core.windows.net/releases/xmcl.appinstaller` mirror.
- `/prebuilds` - GitHub Actions prebuild workflow runs and artifacts
- `POST https://ai.xmcl.app/v1/chat/completions` - Authenticated
  OpenAI-compatible chat proxy. Requires an XMCL access token with `ai:invoke`;
  defaults to the server-owned `agnes-2.5-flash` model, supports `stream: true`
  SSE passthrough, and never forwards the caller's authorization or cookies to
  Agnes. Requests are limited to 4 MiB. The client supplies structured XMCL
  agent context, not a system prompt.

### Agnes chat completions proxy

Configure `AGNES_API_KEYS` as a server-only JSON array of one or more keys, for
example `["first-key","second-key"]`. Store it as one secret value; never put
keys in Wrangler configs, source code, logs, or client settings.
`AGNES_DEFAULT_MODEL` selects the server-owned upstream model and defaults to
`agnes-2.5-flash`. The client model (the Launcher sends `xmcl-agent`) is never
forwarded to Agnes.

The proxy chooses keys round-robin within each runtime isolate. An Agnes `429`
temporarily cools down that key according to `Retry-After` (or the rate-limit
reset header) and retries each other available key at most once. Other HTTP
failures are returned without replay, and a response that has started streaming
is never replayed. Keys of the same Agnes account/type may share one provider
rate-limit pool, so rotation does not guarantee additional aggregate capacity.

The request extends OpenAI Chat Completions with one required top-level `xmcl`
object:

- `promptVersion`: currently `1`.
- `agentType`: `launcher`, `css`, or `modpack-changelog`; `compaction` is
  reserved for the Launcher's internal conversation summarizer.
- `locale`: the launcher UI locale.
- `documents`: optional built-in document IDs/descriptions available to the
  Launcher agent.
- `sessionContext`: structured key/value context. `launcher` sends instance
  path/name, runtime, selected user ID and page; `css` sends
  `{ "scope": "global" }`; `modpack-changelog` sends `releaseContext`.

Client messages may use only `user`, `assistant`, and `tool` roles. A
client-supplied `system` message is rejected. The server validates the
structured context, builds the current Launcher, CSS, changelog, or compaction
system prompt, prepends it for Agnes, and removes `xmcl` from the upstream body.

Example request:

```powershell
$headers = @{
  Authorization = "Bearer <xmcl-access-token>"
  "Content-Type" = "application/json"
}
$body = @{
  xmcl = @{
    promptVersion = 1
    agentType = "launcher"
    locale = "en"
    sessionContext = @{
      instancePath = "C:\Games\XMCL\instances\example"
      instanceName = "Example"
      runtime = @{ minecraft = "1.21.1"; fabricLoader = "0.16.10" }
      userId = "xmcl-user-id"
      page = "/mods"
    }
  }
  messages = @(@{ role = "user"; content = "Hello" })
  stream = $false
} | ConvertTo-Json -Depth 8
Invoke-RestMethod "https://ai.xmcl.app/v1/chat/completions" `
  -Method Post -Headers $headers -Body $body
```

Expected errors include `401 authentication_required` for a missing/invalid XMCL
session, `403 insufficient_scope`, `413 request_too_large`, `429` when the
configured pool is cooling down, `502 ai_provider_unavailable`, and
`503 ai_service_not_configured`. The local-demo profile deliberately does not
mount this real-provider route; its deterministic AI mock remains under
`/v1/ai/*`.

Translation remains on `https://api.xmcl.app/translation`. It has a per-isolate
application guard of 60 requests per minute with a burst of 60 and at most 5
concurrent requests per client IP. The Cloudflare Free Zone edge rule
additionally blocks more than 15 requests per IP per 10 seconds for this path;
the Worker guard is defense in depth and is intentionally not treated as a
globally shared quota.

## Environment Variables

The same variables are used across every runtime (read via `hono/adapter`:
`Deno.env` on Deno, `process.env` on Azure/Node, bindings on Cloudflare).

- `MONGO_CONNECION_STRING` - MongoDB connection string (note the original
  spelling)
- `MONGODB_NAME` - Database name (default: "xmcl-api")
- `GITHUB_PAT` - GitHub Personal Access Token for API access
- `RTC_SECRET` - Secret for WebRTC TURN credential signing
- `XMCL_MULTIPLAYER_TICKET_SECRET` - dedicated secret of at least 32 characters
  for signing multiplayer room admission tickets
- `CURSEFORGE_KEY` - API key for CurseForge integration
- `AGNES_API_KEYS` - server-only JSON array of Agnes API keys for
  `POST /v1/chat/completions`.
- `AGNES_DEFAULT_MODEL` - optional default chat model; defaults to
  `agnes-2.5-flash`.
- `XMCL_MODRINTH_CLIENT_ID` - Modrinth OAuth client ID (defaults to the existing
  registered XMCL client ID)
- `XMCL_MODRINTH_CLIENT_SECRET` - Modrinth OAuth client secret
- `BILLING_CURRENCY` - ISO-4217 settlement currency for the durable billing
  ledger; defaults to `USD`.
- `BILLING_RATES_JSON` - required JSON array of versioned cash rates before
  billing services can be composed. Do not enable public billing routes without
  an approved rate table and a real payment-provider verifier. Shared-hosting
  uses the immutable `hour` rate versions `101` (`6` cents), `102` (`9` cents),
  and `103` (`12` cents).
- Shared hosting subscriptions charge their monthly base fee immediately and
  again at each UTC calendar-month renewal. The approved catalog is Small (4GiB,
  2 shared CPU / burst 4, 32GiB persistent data) at `$4/month + $0.06/h`; Medium
  (6GiB, 3 / burst 6, 48GiB) at `$6/month + $0.09/h`; and Large (8GiB, 4 / burst
  8, 64GiB) at `$8/month + $0.12/h`. The scheduler must settle running shared
  containers against rate versions `101`, `102`, and `103`; it is intentionally
  not enabled in production yet.
- `WAFFO_MERCHANT_ID` and `WAFFO_PRIVATE_KEY` - server-side Waffo API key.
  `WAFFO_STORE_ID`, `WAFFO_PRODUCT_ID`, and `WAFFO_ENVIRONMENT` (`test` or
  `prod`) pin the one-time top-up product and accepted webhook source. The
  product is checked out with a server-owned dynamic price snapshot.
  `WAFFO_SUCCESS_URL`, `WAFFO_API_BASE_URL`, and `WAFFO_WEBHOOK_PUBLIC_KEY` are
  optional. Configure an HTTP webhook for `order.completed` at
  `/v1/webhooks/waffo`; the handler verifies the raw-body signature, store,
  environment, external order ID, currency, and amount before crediting the
  durable ledger.
- Shared-hosting workspaces have one canonical S3-compatible object prefix per
  service. A global scheduler packs only `starting`, `running`, and `stopping`
  containers into a node's hard memory, shared CPU, and local-NVMe workspace
  limits. A trusted node agent restores the canonical workspace before Docker
  start, then flushes it on stop before the API releases the slot. The public
  API never exposes node IDs, object prefixes, or storage credentials.
- Persistent shared-hosting data is measured from the canonical synced revision.
  The plan quota is included in the base fee; an overage gets a seven-day
  notification/grace window and is then blocked from starting. Canonical data is
  never deleted automatically by the quota policy.
- Shared-node transport is mounted only when every required shared-hosting
  setting is present **and** the runtime supplies a server-only
  `SHARED_NODE_WORKSPACE_SIGNER` binding. Cloudflare constructs that binding
  from the Worker secrets `XMCL_VULTR_OBJECT_STORAGE_ACCESS_KEY` and
  `XMCL_VULTR_OBJECT_STORAGE_SECRET_KEY` plus
  `XMCL_VULTR_OBJECT_STORAGE_ENDPOINT`, `XMCL_VULTR_OBJECT_STORAGE_REGION`, and
  `XMCL_VULTR_OBJECT_STORAGE_BUCKET`. The key and secret must be Worker secrets,
  never text responses, node configuration, logs, or exception data. Absent or
  malformed signer configuration leaves internal transport routes unmounted;
  public shared-hosting routes remain disabled.
- The v2 internal transfer contract exposes only authenticated,
  command/assignment/lease-bound `workspace-grants/restore`,
  `workspace-grants/sync`, and `workspace-grants/publish` endpoints. Grants are
  exact short-lived Vultr SigV4 GET/PUT URLs; they never grant List, Delete,
  bucket access, arbitrary keys, or storage credentials. The canonical layout is
  `shared-hosting/<accountId>/<serviceId>/content/<sha256>.tar.zst`,
  `revisions/<revision>/world/<shard>.tar.zst`,
  `revisions/<revision>/config.tar.zst`, and manifest-last
  `revisions/<revision>/manifest.json` (schema version 2). A manifest carries
  its complete safe local-path mapping and descriptor aggregate/manifest hash;
  schema v1 file-per-object manifests are not compatible and must be resynced,
  never silently restored.
- Shared-node provisioning additionally requires `XMCL_SHARED_AGENT_RELEASE_URL`
  / `XMCL_SHARED_AGENT_RELEASE_SHA256` and
  `XMCL_SHARED_QUOTA_HELPER_RELEASE_URL` /
  `XMCL_SHARED_QUOTA_HELPER_RELEASE_SHA256`. Both artifacts are downloaded only
  over HTTPS and SHA-256 verified. The quota helper is installed root-owned at
  `/usr/local/libexec/xmcl-quota-helper`; its configuration is root-owned and
  non-writable by the agent.
- `XMCL_SHARED_NODE_REGION_IDS` is the vendor-neutral comma-separated region
  set advertised by Billing and accepted by the scheduler. It takes precedence
  over the legacy Vultr-specific region settings. The first LightNode MVP uses
  `mow,tpe`.
- `XMCL_SHARED_NODE_CAPACITY_MODE=preprovisioned` runs a fixed operator-enrolled
  pool without dynamic VM creation. This is required for the initial LightNode
  nodes because its published OpenAPI has no cloud-init/user-data or data-disk
  lifecycle endpoints. Capacity requests fail definitively when those nodes are
  full; they do not silently fall through to another geography. Omit the setting
  or use `vultr` to retain dynamic Vultr provisioning.
- `LIGHTNODE_API_TOKEN` is an `x-open-token` credential for the official
  LightNode OpenAPI. `scripts/lightnode_mvp_discovery.ts` uses it to verify the
  Moscow/Taipei region, package, private-image, and firewall identifiers. The
  token is not exposed to nodes or browsers.
- `VULTR_SHARED_NODE_TOTAL_MEMORY_MIB`, `VULTR_SHARED_NODE_TOTAL_SHARED_CPU`,
  and `VULTR_SHARED_NODE_TOTAL_WORKSPACE_GIB` are required positive integers
  with no defaults. They must exactly describe the selected
  `VULTR_SHARED_NODE_PLAN`; the scheduler enrollment and placement limits use
  these values. For Singapore staging with `vc2-6c-16gb`, set `16384`, `6`, and
  `128` respectively. These are deployment settings, not a plan allowlist in
  code.
- `VULTR_SHARED_NODE_BLOCK_STORAGE_GIB` is a required positive integer with no
  default. It must at least cover the selected profile's advertised workspace
  capacity and include headroom for restore/archive/sync staging. The
  `vc2-6c-16gb` Singapore staging profile uses `192` GiB for headroom above its
  `128` GiB workspace capacity. `VULTR_SHARED_NODE_BLOCK_STORAGE_TYPE` is also
  required and must be `high_perf` or `storage_opt`. Size and type directly
  affect recurring Vultr Block Storage charges. Cloud-init receives the created
  volume ID, resolves only its stable `/dev/disk/by-id` link, rejects the root
  disk, and mounts verified XFS with project quotas; operators never configure a
  device path. The volume is disposable node-local cache only after every active
  workspace has successfully synced to canonical Vultr Object Storage. Drain
  retains uncertain resources, then deletes the VM, confirms volume detachment,
  and deletes only the request-owned volume. It also obtains and validates the
  node's public ingress IPv4 only from Vultr's link-local metadata endpoint
  before starting the agent; it never relies on external IP-discovery services.
- Shared nodes additionally require a long-lived, pool-exclusive Vultr Firewall
  Group and the Worker settings `VULTR_SHARED_NODE_FIREWALL_GROUP_ID`,
  `XMCL_SHARED_NODE_INGRESS_PORT_MIN`, and `XMCL_SHARED_NODE_INGRESS_PORT_MAX`.
  Create the group outside this service; provisioning neither creates, deletes,
  nor repairs firewall attachment. Add exactly one inbound rule: IPv4 TCP
  `<min>:<max>` from `0.0.0.0/0`. The scheduler's control-plane range and this
  firewall range must be identical and large enough for the planned concurrent
  services per node. Do not add SSH (22), metrics (9464), Docker (2375/2376),
  RCON, control-plane, storage, or catch-all inbound rules. Leave IPv6
  unassigned/disabled on these VMs unless an equivalent reviewed IPv6 ingress
  design is deployed. The group ID is server-only configuration, never a browser
  request, cloud-init value, node command, or public API response.
- `XMCL_OAUTH_REDIRECT_URIS` - comma-separated exact HTTPS callbacks for website
  OAuth previews. Production always allows exactly
  `https://xmcl.app/oauth/callback` and
  `https://www.xmcl.app/oauth/callback`; register both exact URLs in every
  enabled production OAuth provider application. The launcher callback uses
  `http://127.0.0.1:<port>/commercial-auth` and requires no environment
  configuration.
- XMCL access tokens are stateless signed JWTs with a 10-minute lifetime.
  Authentication verifies the token without reading MongoDB. Refresh-token
  rotation, replay detection, and session revocation remain stateful; revocation
  therefore takes effect immediately for refresh and within 10 minutes for an
  already-issued access token. During rollout only, previously issued 24-hour
  access tokens retain the legacy session lookup until they expire, so existing
  clients remain compatible without widening their former revocation behavior.
- DPoP-capable browser and launcher sessions are sender-constrained. Their JWT
  carries `cnf.jkt`; resource requests use `Authorization: DPoP` plus an ES256
  proof bound to the method, URL, access token, and one-time `jti`. Refresh
  tokens are bound to the same P-256 device key. The launcher stores its private
  key only in OS-backed secret storage, while the website stores a non-exportable
  `CryptoKey` in IndexedDB. Refresh, mutations, RTC credentials, and multiplayer
  use sharded Durable Objects for cross-isolate replay detection on Cloudflare;
  the Azure cold mirror uses a Mongo TTL-backed replay collection. Ordinary
  reads keep a short process-local replay window so access-token verification
  stays horizontally scalable. Unbound Bearer sessions remain accepted during
  client rollout and for browsers that cannot persist a device key; enforcement
  can become mandatory after those clients have drained.
- `TURNS` - TURN server configuration (format: "realm:ip,realm:ip")
- `CLOUDFLARE_API_TOKEN` - Cloudflare TURN API token (optional,
  `/rtc?type=cloudflare`)
- `CLOUDFLARE_APP_ID` - Cloudflare TURN app id (optional)
- Shared-hosting and other commercial routes remain unmounted in the production
  entry points until their complete durable adapter composition is implemented
  in code. The public balance/rate ledger routes are independently enabled.
  Waffo checkout and webhook routes are mounted only when every required Waffo
  setting above is present. This is a code-owned safety boundary, not a
  standalone environment toggle.

### Cloudflare-only bindings

- `MULTIPLAYER_ROOMS` - Durable Object namespace (class `MultiplayerRoomObject`)
  for `/v1/multiplayer/*`
- `api.xmcl.app`, `ai.xmcl.app`, and `signaling.xmcl.app` are custom domains on
  the Worker. The Free Zone edge rate-limiting rule matches the `/translation`
  path (Free does not support a host field); only the common `api.xmcl.app`
  surface mounts that path.
- `XMCL_VULTR_OBJECT_STORAGE_ACCESS_KEY` and
  `XMCL_VULTR_OBJECT_STORAGE_SECRET_KEY` - Worker **secret** bindings for the v2
  S3 SigV4 signer. They require the endpoint, region, and bucket settings above
  and must not be configured on node VMs.

Before production approval, stage the complete real-Vultr path:
`VM enroll ->
restore revision -> start -> stop -> upload blobs -> publish manifest -> report
sync -> slot release -> restore on another node`.
Unit tests and local emulators do not establish production readiness.

Also verify the firewall against an actual provisioned Vultr VM: inspect its
`firewall_group_id`, confirm only the configured Minecraft port range is
reachable, verify metrics/SSH/Docker/RCON are unreachable, start one service on
a reserved port and connect to it, then stop it and verify that port no longer
accepts a Minecraft connection. Do not claim production readiness until both
staged flows complete successfully.

## Development

### Prerequisites

- [Deno](https://deno.land/) for the primary service
- [Node.js](https://nodejs.org/) for the Azure Functions and Cloudflare builds
- [MongoDB](https://www.mongodb.com/) for data storage
- Azure Functions Core Tools (for local Azure Functions testing)
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (for
  Cloudflare)

### Local Development

```bash
npm install

# Deno (primary). Serves the shared app on http://localhost:8080
deno task start

# Cloudflare Workers. Copy apps/.dev.vars.example -> apps/.dev.vars first
npm run dev:api
# Or: npm run dev:ai / npm run dev:signaling

# Azure Functions. Builds apps/azure/index.js, then runs that app's host
npm run build:azure
func start --script-root apps/azure
```

### Local demo (in-memory only)

For a loopback-only, non-production server that exercises the account, billing,
server, backup, worker, AI, modpack, and admin route families without any real
provider credentials, see [LOCAL_DEMO.md](LOCAL_DEMO.md). Start it with
`deno task local-demo` and run its HTTP coverage with
`deno task local-demo:smoke`.

### Type checking

```bash
deno check apps/local/server.ts
npm run typecheck:workers
```

> `apps/azure/index.ts` is a Node-only entry and is validated by its esbuild build
> (`npm run build:azure`), not by `deno check`.

## Deployment

For an isolated deployment of the `mot` branch to an Azure Function deployment
slot or Cloudflare Workers, see [PREVIEW_DEPLOYMENT.md](PREVIEW_DEPLOYMENT.md).

### Local Deno development

The Deno entry exists only for local development. It uses the same npm MongoDB
adapter as Azure and Cloudflare; there is no Deno Deploy or compiled-Deno
production target.

### Azure Functions

Azure is a cold-backup mirror of the API Worker. For deployment, use the Azure
CLI or Azure Portal:

```bash
az functionapp deployment source config-zip -g myResourceGroup -n myFunctionApp --src ./azure.zip
```

### Cloudflare Workers

Cloudflare Workers is the primary production target. Dependencies and Worker
commands are managed by the root npm workspace:

```bash
npm install

# Set secrets per Worker (see .dev.vars.example for the full list)
npx wrangler secret put MONGO_CONNECION_STRING --config apps/api/wrangler.toml
npx wrangler secret put GITHUB_PAT --config apps/api/wrangler.toml
# ...RTC_SECRET, CURSEFORGE_KEY, AGNES_API_KEYS,
#    AZURE_TRANSLATION_TABLE_URL,
#    XMCL_MODRINTH_CLIENT_ID, XMCL_MODRINTH_CLIENT_SECRET,
#    CLOUDFLARE_API_TOKEN, CLOUDFLARE_APP_ID

npm run deploy:workers
```

The signaling Worker owns `MultiplayerRoomObject`; the API Worker owns
`/translation` and scheduled refreshes. The AI Worker has neither cron nor a
Durable Object binding. Geo is resolved natively from `request.cf.country`.
`nodejs_compat` is enabled so the MongoDB driver works on `workerd`; a MongoDB
Atlas connection string is required.

Workers Logs are enabled in each app's `wrangler.toml`. Cloudflare invocation logs
are deliberately disabled because they retain complete URLs, including OAuth
query parameters. Runtime failures emit structured custom records named
`app.exception`, `worker.exception`, `worker.response`, or
`worker.scheduled.exception`, with request ID, method, path, status, duration,
Ray ID and colo where available. Request/response bodies, query strings,
authorization values and token material are never logged.

Use the corresponding Worker observability page (`xmcl-web-api`, `xmcl-web-ai`,
or `xmcl-web-signaling`) or stream live logs:

```bash
npx wrangler tail --config apps/api/wrangler.toml
```

Filter by `event` or `requestId`. Cloudflare platform rejections that happen
before Worker invocation, notably `429 error code: 1027`, cannot emit Worker
logs; check **Workers & Pages → Usage** and plan limits for those.

Launcher update traffic is protected from GitHub fan-out inside each runtime
isolate. Release and notification requests share concurrent fetches and cache
successful results for five minutes; stale release data can be served for 24
hours during a GitHub outage or rate-limit cooldown. Missing localized
changelogs and community translation files are negatively cached for six hours.
GitHub `403`/`429` responses emit only `github.upstream.rate_limited` metadata
(`resource`, `host`, `status`, `retryAt`) and never the PAT or response body.
`GITHUB_PAT` is optional for public data but strongly recommended:
unauthenticated GitHub REST traffic is limited to 60 requests/hour per source
IP, while authenticated user tokens normally receive 5,000 requests/hour.

### Custom Server (China)

For the China service, deploy to a suitable hosting provider with Go support:

```bash
go build -o server main.go
# Then deploy the binary to your server
```

## TURN Server

For WebRTC functionality, a COTURN server is used. Configuration details are in
`COTURN.md`.

## License

This project is licensed under the MIT License - see the LICENSE file for
details.
