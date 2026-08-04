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

The API is built as a **single shared [Hono](https://hono.dev) application**
that runs unchanged on three runtimes via thin per-platform entry points. All
HTTP routes live in [`src/`](src/) and are registered once in
[`src/app.ts`](src/app.ts). Each platform entry only wires up runtime-specific
behaviour (geo lookup, realtime transport, translation queue) through Hono
context variables.

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
  platform/         translation_deno.ts (Deno.Kv queue)
  translation_service.ts  runTranslation(): shared translate + cache logic

index.ts            Deno entry      → Deno.serve
cloudflare/worker.ts  Cloudflare entry → fetch/queue/scheduled + MultiplayerRoom DO
azure/index.ts      Azure entry     → @azure/functions HTTP trigger
```

Storage uses [`@mikro-orm/mongodb`](https://jsr.io/@mikro-orm/mongodb) purely as
a **cross-runtime MongoDB connector** (Node, Deno, Cloudflare Workers). No
entities are registered — the code accesses raw collections via
`orm.em.getConnection().getCollection(name)` so the existing document shapes are
untouched and `new Function`/JIT (forbidden on `workerd`) is avoided.

### Platform-specific behaviour

| Concern                   | Deno                           | Cloudflare Workers                             | Azure Functions            |
| ------------------------- | ------------------------------ | ---------------------------------------------- | -------------------------- |
| HTTP server               | `Deno.serve(app.fetch)`        | `export default { fetch }`                     | HTTP trigger → `app.fetch` |
| Geo                       | `geoip-country` (forwarded IP) | `request.cf.country` (native)                  | `geoip-country`            |
| `/group/:id`              | native WS + `BroadcastChannel` | not supported → `501`                          | not supported → `501`      |
| `/v2/multiplayer/rooms/*` | not supported → `501`          | authenticated `MultiplayerRoom` Durable Object | not supported → `501`      |
| `/translation`            | `Deno.Kv` queue                | Cloudflare Queue + KV semaphore                | inline (no queue)          |

WebSocket upgrades for `/group/:id` are intercepted by the Deno entry before
the Hono app runs, so the CORS middleware never touches the immutable `101`
response. Cloudflare supports only multiplayer v2.

### Multiplayer rooms

Cloudflare multiplayer v2 uses one `MultiplayerRoom` Durable Object per room.
The object owns room membership, owner actions, expiry, and WebRTC signaling;
Minecraft traffic remains peer-to-peer and falls back to the existing built-in
TURN servers returned by `/rtc/official`. Cloudflare TURN remains an explicit
opt-in through `/rtc/official?type=cloudflare`; multiplayer v2 does not select
it by default. Game traffic is never relayed through the Durable Object.

The topology is host-star rather than full mesh. The host keeps one hibernating
control WebSocket so future guests can negotiate immediately. A guest opens a
temporary WebSocket only for SDP/ICE exchange with the host and closes it after
the WebRTC connection is ready. Guests never establish WebRTC links with each
other, and the host reports later guest disconnections over its control socket.

Authenticated XMCL sessions use:

- `POST /v2/multiplayer/rooms` to create a room and owner admission ticket;
- `POST /v2/multiplayer/rooms/:roomId/join` to obtain a member ticket;
- `GET /v2/multiplayer/rooms/:roomId/socket?ticket=...` to upgrade WebSocket;
- `DELETE /v2/multiplayer/rooms/:roomId` to close an owned room.

Set the Worker secret `XMCL_MULTIPLAYER_TICKET_SECRET` to at least 32 random
characters. Admission tickets expire after five minutes and are single-use.
Rooms support 2-16 peers, expire after 24 hours, and allow the host 30 seconds
to restore its control socket before closing. Closed rooms delete their Durable
Object storage. The legacy unauthenticated `/group/:id` protocol remains
available only on the Deno deployment.

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
- `/releases/:filename` - Access to launcher release files with redirection to
  GitHub
- `/notifications` - System notifications for launcher users from GitHub issues
- `/flights` - Feature flight information for gradual rollouts
- `/translation` - Translation services for mod descriptions (Modrinth and
  CurseForge)
- `/group/:id` - Real-time WebSocket communication for launcher user groups
  (Deno: native WS + `BroadcastChannel`; Cloudflare/Azure: return `501`)
- `/rtc/official` - WebRTC signaling for peer connections
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
- `/v1/auth/*`, `/v1/sessions/*`, `/v1/account/*` - XMCL account, OAuth, and
  session APIs
- `POST /v1/auth/gateway-token` - Exchanges an authenticated XMCL session for a
  short-lived RS256 token for offline service verification
- `GET /.well-known/jwks.json` - Public keys for offline XMCL token verification
- `GET /llm-pool` - Service-secret-protected tiered LLM routing configuration

## Environment Variables

The same variables are used across every runtime (read via `hono/adapter`:
`Deno.env` on Deno, `process.env` on Azure/Node, bindings on Cloudflare).

- `MONGO_CONNECION_STRING` - MongoDB connection string (note the original
  spelling)
- `MONGODB_NAME` - Database name (default: "xmcl-api")
- `GITHUB_PAT` - GitHub Personal Access Token for API access
- `AGNES_API_KEY` - API key for translation (Agnes API)
- `RTC_SECRET` - Secret for WebRTC TURN credential signing
- `CURSEFORGE_KEY` - API key for CurseForge integration
- `MODRINTH_SECRET` - Secret for Modrinth authentication integration
- `TURNS` - TURN server configuration (format: "realm:ip,realm:ip")
- `CLOUDFLARE_API_TOKEN` - Cloudflare TURN API token (optional,
  `/rtc?type=cloudflare`)
- `CLOUDFLARE_APP_ID` - Cloudflare TURN app id (optional)
- `XMCL_SESSION_SECRET` - At least 32 characters used to sign XMCL session
  access tokens
- `XMCL_OFFLINE_JWT_PRIVATE_JWK` - Complete RSA private JWK used to sign
  short-lived offline-service tokens; set as a Worker secret
- `XMCL_OFFLINE_JWT_PREVIOUS_PUBLIC_JWKS` - Optional public JWKS containing old
  verification keys retained during signing-key rotation
- `XMCL_OFFLINE_JWT_KEY_ID` - Published JWT key id (default:
  `xmcl-offline-1`)
- `XMCL_OFFLINE_JWT_ISSUER` - Offline token issuer (default:
  `https://api.xmcl.app`)
- `XMCL_OFFLINE_JWT_AUDIENCE` - Offline token audience (default:
  `xmcl-ai-routing`)
- `XMCL_OFFLINE_JWT_TTL_SECONDS` - Token lifetime from 60 to 900 seconds
  (default: 900)
- `LLM_POOL_SERVICE_SECRET` - Secret required in the `x-service-secret` header
  by `/llm-pool`
- `LLM_POOL_SERVICE_HEADER` - Optional service-secret header name override
- `LLM_POOL_CONFIG` - Secret JSON object keyed by account tier, whose values are
  arrays of `{ "endpoint", "model", "key" }`

### LLM gateway authentication contract

Clients continue to receive the existing revocable XMCL session token after
OAuth sign-in. Before calling the LLM gateway, a client exchanges that session:

```http
POST /v1/auth/gateway-token
Authorization: Bearer <xmcl-session-token>
```

```json
{
  "accessToken": "<rs256-jwt>",
  "tokenType": "Bearer",
  "expiresIn": 900,
  "expiresAt": "2026-08-04T07:30:00.000Z"
}
```

The JWT header is `{ "alg": "RS256", "typ": "at+jwt", "kid": "..." }`.
Claims include `iss`, `aud`, `sub` (XMCL account id), `sid`, `scope`, `tier`,
`iat`, and `exp`. `xmcl-ai-routing` validates it locally from
`/.well-known/jwks.json`; it does not connect to MongoDB. Revoking the original
XMCL session prevents new gateway tokens, while an already-issued gateway token
remains valid for at most fifteen minutes. The gateway checks expiry when a
request starts; an accepted streaming response may continue after token expiry.

The gateway retrieves routing configuration with:

```http
GET /llm-pool
X-Service-Secret: <service-secret>
```

The response is a tier-keyed object:

```json
{
  "free": [
    {
      "endpoint": "https://api.openai.com",
      "model": "gpt-4.1-mini",
      "key": "<provider-key>"
    }
  ]
}
```

The response uses `Cache-Control: no-store`; the gateway owns the one-hour
in-memory cache. Provider keys are stored only in the encrypted Worker secret.

Generate a new signing key without writing it to disk:

```sh
deno run scripts/generateOfflineJwtKey.ts xmcl-offline-2026-08
```

Set its `privateJwk` as `XMCL_OFFLINE_JWT_PRIVATE_JWK`. During rotation, put the
old public JWK in `XMCL_OFFLINE_JWT_PREVIOUS_PUBLIC_JWKS`, deploy the new key,
and retain the old public key for at least the token TTL plus the JWKS cache
duration.
- `XMCL_MICROSOFT_CLIENT_ID`, `XMCL_MICROSOFT_CLIENT_SECRET` - Microsoft OAuth
  application credentials
- `XMCL_MODRINTH_CLIENT_ID`, `XMCL_MODRINTH_CLIENT_SECRET` - Modrinth OAuth
  credentials; the client ID defaults to XMCL's registered client
- `XMCL_GOOGLE_CLIENT_ID`, `XMCL_GOOGLE_CLIENT_SECRET` - Google OAuth
  application credentials
- `XMCL_DISCORD_CLIENT_ID`, `XMCL_DISCORD_CLIENT_SECRET` - Discord OAuth
  application credentials
- `XMCL_OAUTH_REDIRECT_URIS` - Comma-separated exact HTTPS website callbacks.
  Register every callback in each enabled provider; the launcher uses its
  code-owned loopback callback and needs no configuration.

### Cloudflare-only bindings (wrangler.toml)

- `MULTIPLAYER_ROOM` - Durable Object namespace for authenticated multiplayer v2
- `TRANSLATION_KV` - KV namespace for the translation semaphore
- `TRANSLATION_QUEUE` - Queue for offloading `/translation` work (optional)

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
# Deno (primary). Serves the shared app on http://localhost:8080
deno task start

# Cloudflare Workers. Copy cloudflare/.dev.vars.example -> cloudflare/.dev.vars first
cd cloudflare && npm install && npm run dev

# Azure Functions. Builds the shared app into azure/index.js, then runs the host
npm install
npm run build:azure
func start
```

### Type checking

```bash
deno check index.ts              # Deno entry + all shared src
deno check cloudflare/worker.ts  # Cloudflare entry + all shared src
```

> `azure/index.ts` is a Node-only entry and is validated by its esbuild build
> (`npm run build:azure`), not by `deno check`.

## Deployment

### Deno Deploy

The primary service is deployed on Deno Deploy, which automatically deploys from
the main branch.

### Azure Functions

For Azure Functions deployment, use the Azure CLI or Azure Portal:

```bash
az functionapp deployment source config-zip -g myResourceGroup -n myFunctionApp --src ./azure.zip
```

### Cloudflare Workers

The shared app also runs on Cloudflare Workers. From the
[`cloudflare/`](cloudflare/) folder:

```bash
cd cloudflare
npm install

# Create the KV namespace and put its id into wrangler.toml, then the queue
wrangler kv namespace create TRANSLATION_KV
wrangler queues create xmcl-translation

# Set secrets (see .dev.vars.example for the full list)
wrangler secret put MONGO_CONNECION_STRING
wrangler secret put GITHUB_PAT
wrangler secret put XMCL_SESSION_SECRET
wrangler secret put XMCL_OFFLINE_JWT_PRIVATE_JWK
wrangler secret put XMCL_OFFLINE_JWT_PREVIOUS_PUBLIC_JWKS
wrangler secret put LLM_POOL_SERVICE_SECRET
wrangler secret put LLM_POOL_CONFIG
# ...RTC_SECRET, AGNES_API_KEY, CURSEFORGE_KEY,
#    MODRINTH_SECRET, CLOUDFLARE_API_TOKEN, CLOUDFLARE_APP_ID

wrangler deploy
```

The `MultiplayerRoom` Durable Object backs authenticated multiplayer v2. The
Queue + KV pair handle `/translation`, and geo is resolved natively from
`request.cf.country`. `nodejs_compat` is enabled so the MongoDB driver works on
`workerd`; a MongoDB Atlas connection string is required.

### Alibaba Cloud Function

The Deno service can be deployed to Alibaba Cloud Function using Serverless Devs
with a compiled binary:

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

The deployment uses a compiled Deno binary and automatically deploys from the
main branch via GitHub Actions.

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

For WebRTC functionality, a COTURN server is used. Configuration details are in
`COTURN.md`.

## License

This project is licensed under the MIT License - see the LICENSE file for
details.
