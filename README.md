# XMCL Web API

This repository contains the server-side code for the X-Minecraft Launcher (XMCL) web API. It provides various backend services that support the launcher functionality.

## Overview

The XMCL Web API serves multiple functions:
- Provides launcher update notifications and release information
- Manages real-time communication for multiplayer sessions
- Handles translations for mod descriptions and UI elements
- Offers WebRTC services for peer-to-peer connections
- Supports authentication with various services

## Architecture

The API is built as a **single shared [Hono](https://hono.dev) application** that
runs unchanged on three runtimes via thin per-platform entry points. All HTTP
routes live in [`src/`](src/) and are registered once in
[`src/app.ts`](src/app.ts). Each platform entry only wires up runtime-specific
behaviour (geo lookup and realtime transport) through Hono context variables.

```
src/
  app.ts            createApp(): the shared Hono app (all routes)
  config.ts         getConfig(c): env vars via hono/adapter (Deno/Node/CF)
  db.ts             MikroORM MongoDB connector (native collection access)
  types.ts          AppEnv (bindings + context variables)
  geo.ts            isChineseRequest(): CF country or geoip country var
  proxy.ts          header forwarding helpers
  routes/           one Hono sub-app per endpoint
  middleware/       db, auth (minecraft/microsoft), geoip (Deno/Azure only)
  lib/              html splitting, translation (Agnes), xxhash hasher
  realtime/         group_deno.ts (native WS + BroadcastChannel), match.ts
  translation_requests.ts durable Mongo request ledger and worker lease contract
  translation_service.ts  runTranslation(): external worker translate + cache logic

index.ts            Deno entry      → Deno.serve
cloudflare/worker.ts  Cloudflare entry → fetch/scheduled + GroupRoom DO
azure/index.ts      Azure entry     → @azure/functions HTTP trigger
```

Storage uses [`@mikro-orm/mongodb`](https://jsr.io/@mikro-orm/mongodb) purely as
a **cross-runtime MongoDB connector** (Node, Deno, Cloudflare Workers). No
entities are registered — the code accesses raw collections via
`orm.em.getConnection().getCollection(name)` so the existing document shapes are
untouched and `new Function`/JIT (forbidden on `workerd`) is avoided.

### Platform-specific behaviour

| Concern | Local/compatibility Deno | Cloudflare Workers (production realtime) | Azure Functions |
| --- | --- | --- | --- |
| HTTP server | `Deno.serve(app.fetch)` | `export default { fetch }` | HTTP trigger → `app.fetch` |
| Geo | `geoip-country` (forwarded IP) | `request.cf.country` (native) | `geoip-country` |
| `/group/:id` | native WS + `BroadcastChannel` | `GroupRoom` Durable Object | not supported → `501` |
| `/translation` | Mongo request ledger | Mongo request ledger | Mongo request ledger |

WebSocket upgrades for `/group/:id` are intercepted in each entry **before**
the Hono app runs, so the CORS middleware never touches the immutable `101`
response.

### Translation batch worker

`GET /translation` fetches and hashes the source before checking the existing
`<lang>_translation` cache. A matching cache entry returns `200`. On a miss,
the route atomically creates or updates one `translation_requests` document
with `_id` `<lang>:<type>:<projectId>`, then returns `202` and
`Retry-After: 86400`. The API never queues, polls, or translates that request
inline.

The ledger contains only source metadata: `lang`, `type`, `projectId`,
`bodyHash`, `contentType`, `status`, request timestamps/count, `attempts`,
lease fields, `lastError`, and optional `notBefore`. It never stores a source
body. A changed source hash resets the document to `pending` and invalidates
any outstanding lease.

An external scheduled GitHub Actions worker connects directly to the same
Cosmos DB Mongo API and imports
[`src/translation_requests.ts`](src/translation_requests.ts). Its machine
interface accepts the existing raw collection adapter; it needs no API admin
endpoint:

```ts
import type { Db, MongoCollection } from "./src/db.ts";

const db: Db = {
  collection: (name) =>
    mongoDatabase.collection(name) as unknown as MongoCollection,
};
```

Its machine contract is:

1. Call `claimNextTranslationRequest(db, { workerId, claimToken })`. It
   atomically leases one eligible `pending` request, or a retryable `failed`
   request whose `notBefore` has elapsed. Keep the returned `_id`, `bodyHash`,
   and `claimToken`; generate a unique token such as `crypto.randomUUID()`.
2. Refetch the source from `type` and `projectId`, hash it, and compare it to
   the claimed `bodyHash`. If it changed, call `recordTranslationRequest` with
   the new hash and stop processing that lease. Do not persist the body.
3. With a matching hash, call `runTranslation(db, job, keys)` to write the
   final `<lang>_translation` cache. Build `job.id` from `projectId` and pass
   the freshly fetched body only in memory, then call
   `completeTranslationRequest(db, { requestId, bodyHash, claimToken })`.
   A `false` completion result means that lease is stale and must not make any
   further ledger changes.
4. On an error call `failTranslationRequest`. Pass `retryAt` for a retryable
   error; omitting it records a terminal `failed` request. Claims and
   completion/failure operations match both token and source hash, so an
   expired worker cannot overwrite a newer source version.

These helpers use only atomic single-document Mongo operations
(`updateOne`/`findOneAndUpdate`), which are compatible with the Cosmos DB
Mongo API and require no transaction, Cloudflare Queue, Durable Object, or
Worker Cron translation consumer.

The batch worker, not an API runtime, owns its `AGNES_API_KEY` secret.

### Other deployments

- **Alibaba Cloud Function (Deno)** — runs the same `index.ts` via a compiled
  Deno binary (`aliyun/bootstrap`) for better access in mainland China.

> **Cloudflare + MikroORM caveat:** if entities are ever added, run
> `mikro-orm compile` and load metadata with `GeneratedCacheAdapter`, because
> `workerd` forbids the runtime metadata discovery (`new Function`) MikroORM
> uses by default. With the current entity-less native-collection approach this
> is not needed.


## API Endpoints

All runtimes serve the same routes (defined once in [`src/app.ts`](src/app.ts)):

- `/latest` - Provides information about the latest launcher releases
- `/releases/:filename` - Access to launcher release files with redirection to GitHub
- `/notifications` - System notifications for launcher users from GitHub issues
- `/flights` - Feature flight information for gradual rollouts
- `/translation` - Translation services for mod descriptions (Modrinth and CurseForge)
- `/group/:id` - Real-time WebSocket communication for launcher user groups
  (Deno: native WS + `BroadcastChannel`; Cloudflare: `GroupRoom` Durable Object;
  Azure: returns `501`)
- `/rtc/official` - WebRTC signaling for peer connections
- `/zulu` - Proxies the Zulu JRE manifest from xmcl-static-resource
- `/elyby/authlib` - Authentication library access
- `/modrinth/auth` - Modrinth authentication integration
- `/kook-badge` - Access to KOOK integration information
- `/appx?version=<v>` - 302 to the Windows `.appx` (geo-aware: `cdn.xmcl.app`
  for mainland China, GitHub otherwise)
- `/appinstaller` - Dynamically-generated `.appinstaller` manifest pointing
  at the latest stable release. Replaces the static
  `xmcl.blob.core.windows.net/releases/xmcl.appinstaller` mirror.
- `/prebuilds` - GitHub Actions prebuild workflow runs and artifacts


## Environment Variables

The same variables are used across every runtime (read via `hono/adapter`:
`Deno.env` on Deno, `process.env` on Azure/Node, bindings on Cloudflare).

- `MONGO_CONNECION_STRING` - MongoDB connection string (note the original spelling)
- `MONGODB_NAME` - Database name (default: "xmcl-api")
- `GITHUB_PAT` - GitHub Personal Access Token for API access
- `RTC_SECRET` - Secret for WebRTC TURN credential signing
- `CURSEFORGE_KEY` - API key for CurseForge integration
- `XMCL_MODRINTH_CLIENT_ID` - Modrinth OAuth client ID (defaults to the
  existing registered XMCL client ID)
- `XMCL_MODRINTH_CLIENT_SECRET` - Modrinth OAuth client secret
- `BILLING_CURRENCY` - ISO-4217 settlement currency for the durable billing
  ledger; defaults to `USD`.
- `BILLING_RATES_JSON` - required JSON array of versioned cash rates before
  billing services can be composed. Do not enable public billing routes without
  an approved rate table and a real payment-provider verifier. Shared-hosting
  uses the immutable `hour` rate versions `101` (`6` cents), `102` (`9`
  cents), and `103` (`12` cents).
- Shared hosting subscriptions charge their monthly base fee immediately and
  again at each UTC calendar-month renewal. The approved catalog is Small
  (4GiB, 2 shared CPU / burst 4, 32GiB persistent data) at `$4/month + $0.06/h`;
  Medium (6GiB, 3 / burst 6, 48GiB) at `$6/month + $0.09/h`; and Large (8GiB,
  4 / burst 8, 64GiB) at `$8/month + $0.12/h`. The scheduler must settle
  running shared containers against rate versions `101`, `102`, and `103`;
  it is intentionally not enabled in production yet.
- `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`,
  `PAYPAL_RETURN_URL`, and `PAYPAL_CANCEL_URL` - required together for the
  production PayPal Orders API and signed webhook verifier. `PAYPAL_API_BASE_URL`
  is optional and defaults to `https://api-m.paypal.com`.
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
  `XMCL_VULTR_OBJECT_STORAGE_ENDPOINT`,
  `XMCL_VULTR_OBJECT_STORAGE_REGION`, and
  `XMCL_VULTR_OBJECT_STORAGE_BUCKET`. The key and secret must be Worker
  secrets, never text responses, node configuration, logs, or exception data.
  Absent or malformed signer configuration leaves internal transport routes
  unmounted; public shared-hosting routes remain disabled.
- The v2 internal transfer contract exposes only authenticated,
  command/assignment/lease-bound `workspace-grants/restore`,
  `workspace-grants/sync`, and `workspace-grants/publish` endpoints. Grants
  are exact short-lived Vultr SigV4 GET/PUT URLs; they never grant List, Delete,
  bucket access, arbitrary keys, or storage credentials. The canonical layout
  is `shared-hosting/<accountId>/<serviceId>/content/<sha256>.tar.zst`,
  `revisions/<revision>/world/<shard>.tar.zst`,
  `revisions/<revision>/config.tar.zst`, and manifest-last
  `revisions/<revision>/manifest.json` (schema version 2). A manifest carries
  its complete safe local-path mapping and descriptor aggregate/manifest hash;
  schema v1 file-per-object manifests are not compatible and must be resynced,
  never silently restored.
- Shared-node provisioning additionally requires
  `XMCL_SHARED_AGENT_RELEASE_URL` / `XMCL_SHARED_AGENT_RELEASE_SHA256` and
  `XMCL_SHARED_QUOTA_HELPER_RELEASE_URL` /
  `XMCL_SHARED_QUOTA_HELPER_RELEASE_SHA256`. Both artifacts are downloaded only
  over HTTPS and SHA-256 verified. The quota helper is installed root-owned at
  `/usr/local/libexec/xmcl-quota-helper`; its configuration is root-owned and
  non-writable by the agent.
- `VULTR_SHARED_NODE_BLOCK_STORAGE_GIB` is a required positive integer with no
  default. It must at least cover the selected profile's advertised workspace
  capacity and include headroom for restore/archive/sync staging.
  `VULTR_SHARED_NODE_BLOCK_STORAGE_TYPE` is also required and must be
  `high_perf` or `storage_opt`. Size and type directly affect recurring Vultr
  Block Storage charges. Cloud-init receives the created volume ID, resolves
  only its stable `/dev/disk/by-id` link, rejects the root disk, and mounts
  verified XFS with project quotas; operators never configure a device path.
  The volume is disposable node-local cache only after every active workspace
  has successfully synced to canonical Vultr Object Storage. Drain retains
  uncertain resources, then deletes the VM, confirms volume detachment, and
  deletes only the request-owned volume. It also obtains and validates the
  node's public ingress IPv4 only from Vultr's link-local metadata endpoint
  before starting the agent; it never relies on external IP-discovery services.
- Shared nodes additionally require a long-lived,
  pool-exclusive Vultr Firewall Group and the Worker settings
  `VULTR_SHARED_NODE_FIREWALL_GROUP_ID`,
  `XMCL_SHARED_NODE_INGRESS_PORT_MIN`, and
  `XMCL_SHARED_NODE_INGRESS_PORT_MAX`. Create the group outside this service;
  provisioning neither creates, deletes, nor repairs firewall attachment. Add
  exactly one inbound rule: IPv4 TCP `<min>:<max>` from `0.0.0.0/0`. The
  scheduler's control-plane range and this firewall range must be identical and
  large enough for the planned concurrent services per node. Do not add SSH
  (22), metrics (9464), Docker (2375/2376), RCON, control-plane, storage, or
  catch-all inbound rules. Leave IPv6 unassigned/disabled on these VMs unless an
  equivalent reviewed IPv6 ingress design is deployed. The group ID is
  server-only configuration, never a browser request, cloud-init value, node
  command, or public API response.
- `XMCL_OAUTH_REDIRECT_URIS` - comma-separated exact HTTPS callbacks for
  website OAuth. For the production website this includes
  `https://xmcl.app/oauth/callback`; register the same exact URL in every
  enabled OAuth provider application. The launcher callback uses
  `http://127.0.0.1:<port>/commercial-auth` and requires no environment
  configuration.
- `TURNS` - TURN server configuration (format: "realm:ip,realm:ip")
- `CLOUDFLARE_API_TOKEN` - Cloudflare TURN API token (optional, `/rtc?type=cloudflare`)
- `CLOUDFLARE_APP_ID` - Cloudflare TURN app id (optional)
- Shared-hosting and other commercial routes remain unmounted in the production
  entry points until their complete durable adapter composition is implemented
  in code. The public balance/rate ledger routes are independently enabled;
  PayPal routes remain code-gated until pending-order reconciliation is deployed.
  This is a code-owned safety boundary, not an environment toggle.

### Cloudflare-only bindings (wrangler.toml)

- `GROUP_ROOM` - Durable Object namespace (class `GroupRoom`) for `/group/:id`
- `XMCL_VULTR_OBJECT_STORAGE_ACCESS_KEY` and
  `XMCL_VULTR_OBJECT_STORAGE_SECRET_KEY` - Worker **secret** bindings for the
  v2 S3 SigV4 signer. They require the endpoint, region, and bucket settings
  above and must not be configured on node VMs.

Before production approval, stage the complete real-Vultr path: `VM enroll ->
restore revision -> start -> stop -> upload blobs -> publish manifest -> report
sync -> slot release -> restore on another node`. Unit tests and local emulators
do not establish production readiness.

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
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (for Cloudflare)

### Local Development

```bash
# Deno (primary). Serves the shared app on http://localhost:8080
deno task start

# Cloudflare Workers. Copy cloudflare/.dev.vars.example -> cloudflare/.dev.vars first
cd cloudflare && npm install && npm run dev

# Azure Functions. Builds the shared app into azure/index.js, then runs the host
npm install
npm run build:azure
func start
```

### Local demo (in-memory only)

For a loopback-only, non-production server that exercises the account,
billing, server, backup, worker, AI, modpack, and admin route families without
any real provider credentials, see [LOCAL_DEMO.md](LOCAL_DEMO.md). Start it
with `deno task local-demo` and run its HTTP coverage with
`deno task local-demo:smoke`.

### Type checking

```bash
deno check index.ts              # Deno entry + all shared src
deno check cloudflare/worker.ts  # Cloudflare entry + all shared src
```

> `azure/index.ts` is a Node-only entry and is validated by its esbuild build
> (`npm run build:azure`), not by `deno check`.


## Deployment

For an isolated deployment of the `mot` branch to an Azure Function deployment
slot or Cloudflare Workers, see
[PREVIEW_DEPLOYMENT.md](PREVIEW_DEPLOYMENT.md).

### Deno compatibility

The Deno entry is for local development and compatible self-hosted/Alibaba
deployments. Deno Deploy is not a deployment target.

### Azure Functions

For Azure Functions deployment, use the Azure CLI or Azure Portal:

```bash
az functionapp deployment source config-zip -g myResourceGroup -n myFunctionApp --src ./azure.zip
```

### Cloudflare Workers

Cloudflare Workers is the production realtime target. From the
[`cloudflare/`](cloudflare/) folder:

```bash
cd cloudflare
npm install

# Set secrets (see .dev.vars.example for the full list)
wrangler secret put MONGO_CONNECION_STRING
wrangler secret put GITHUB_PAT
# ...RTC_SECRET, CURSEFORGE_KEY,
#    XMCL_MODRINTH_CLIENT_ID, XMCL_MODRINTH_CLIENT_SECRET,
#    CLOUDFLARE_API_TOKEN, CLOUDFLARE_APP_ID

wrangler deploy
```

The `GroupRoom` Durable Object backs `/group/:id` (replacing the Deno
`BroadcastChannel` fan-out), while `/translation` records durable Mongo
requests for the external batch worker. The Worker Cron remains available only
to its unrelated scheduled services. Geo is resolved natively from
`request.cf.country`. `nodejs_compat` is enabled so the MongoDB driver works on
`workerd`; a MongoDB Atlas connection string is required.


### Alibaba Cloud Function

The Deno service can be deployed to Alibaba Cloud Function using Serverless Devs with a compiled binary:

```bash
# Install Serverless Devs CLI
npm install -g @serverless-devs/s

# Configure your Alibaba Cloud credentials
s config add

# Compile the Deno application
deno compile --allow-net --allow-read --allow-env \
  --output aliyun/xmcl-api \
  index.ts

# Deploy the function
s deploy --use-local -y
```

The deployment uses a compiled Deno binary and automatically deploys from the main branch via GitHub Actions.

**Required Secrets for GitHub Actions:**
- `ALIYUN_ACCOUNT_ID` - Alibaba Cloud Account ID
- `ALIYUN_ACCESS_KEY_ID` - Alibaba Cloud Access Key ID
- `ALIYUN_ACCESS_KEY_SECRET` - Alibaba Cloud Access Key Secret
- Environment variables (same as Primary Service)

### Custom Server (China)

For the China service, deploy to a suitable hosting provider with Go support:

```bash
go build -o server main.go
# Then deploy the binary to your server
```

## TURN Server

For WebRTC functionality, a COTURN server is used. Configuration details are in `COTURN.md`.

## License

This project is licensed under the MIT License - see the LICENSE file for details.