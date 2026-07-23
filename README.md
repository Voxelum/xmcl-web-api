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
- `XMCL_OAUTH_REDIRECT_URIS` - optional comma-separated exact HTTPS callbacks
  for website OAuth. The launcher callback uses
  `http://127.0.0.1:<port>/commercial-auth` and requires no environment
  configuration.
- `TURNS` - TURN server configuration (format: "realm:ip,realm:ip")
- `CLOUDFLARE_API_TOKEN` - Cloudflare TURN API token (optional, `/rtc?type=cloudflare`)
- `CLOUDFLARE_APP_ID` - Cloudflare TURN app id (optional)
- Commercial routes remain unmounted in the production entry points until their
  complete durable adapter composition is implemented in code. This is a
  code-owned safety boundary, not an environment toggle.

### Cloudflare-only bindings (wrangler.toml)

- `GROUP_ROOM` - Durable Object namespace (class `GroupRoom`) for `/group/:id`


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