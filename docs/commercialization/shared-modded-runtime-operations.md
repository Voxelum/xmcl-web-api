# Shared modded runtime compiler deployment

The shared-hosting modded path is intentionally fail-closed. It is not enabled
by the existing public shared-hosting gate until all dependencies below are
installed.

## Local instance bundles

The launcher can import `sourceFormat: "xmcl_server_bundle"` through the same
account/service-owned modpack-import flow. It starts from an already-working
local modded **client** instance. Its `.xmcl-server-bundle` is a versioned
deterministic archive containing `bundle.json`, selected server-relevant
instance content (including mods, config, KubeJS, scripts, and opted-in
server-relevant resources), loader/version metadata, and hashes with explicit
content intent in `resolved/artifacts.json`; it contains no local server
executable or classpath.
The compiler independently assembles a dedicated-server runtime. The API
records the expected SHA-256 and size before issuing one short-lived exact PUT;
it does not accept a browser-supplied object key.

Completion re-reads that exact object, validates ZIP safety, every manifest
path/hash, and an exact reviewed toolchain tuple (canonical Minecraft version,
loader kind/version, Java component/major, and runtime-catalog SHA). `26.2`
with Fabric `0.19.3` and Java 25 is a reviewed tuple. Version identifiers are
bounded canonical numeric IDs only; paths, whitespace/control characters, URLs,
commands, and non-catalog versions reject. It freezes only a compiler input grant for the service-owned
archive key and one immutable `If-None-Match: *` content PUT. Local Java
paths, JVM arguments, Docker choices, URLs, `server.sh`/`server.bat`, worlds,
and account/private data are not executable input. World migration remains a
separate explicit operation after deployment creation.

## Required external deployment

1. Deploy an egress-isolated compiler worker. It needs a non-root ephemeral
   workspace, resource/PID limits, no Docker socket or host mounts, approved
   HTTPS artifact origins only, bounded redirects/sizes/timeouts, and network
   removal after acquisition.
2. Azure composes the `SharedModdedCompiler` HTTP adapter, durable callback
   identity, and `SharedModdedArchiveStore` only after the settings below
   validate. Other platforms remain fail-closed. Do not substitute legacy
   dedicated-worker staging.
3. Azure injects `CompilerGrantAuthority` using the server-only S3 signer. Compiler
   grants provide only the frozen import GET and exact immutable content PUT;
   they cannot list/delete, read worlds, or act as node grants.
4. Inject the same `SharedModdedRuntimeService` as
   `SharedRuntimeContentGrantAuthority` into `SharedNodeTransportService`.
   This authorizes a node restore GET only for the currently selected,
   published deployment.
5. Publish the generic runtime image from
   [`Voxelum/xmcl-shared-minecraft-runtime`](https://github.com/Voxelum/xmcl-shared-minecraft-runtime)
   with the same reviewed `runtime-catalog.lock.json` revision compiled into the
   control plane and node agent, then configure the agent with its immutable
   GHCR digest. The catalog currently contains Java 8/16/17/21/25.
6. Connect the server-side EULA/terms acceptance policy to
   `eulaAccepted`. The runtime launcher rejects starts without that trusted
   command field; user content cannot set it.

## Azure compiler control-plane activation

Azure mounts no public shared-hosting or modpack routes. It adds only these
private callback routes, and only if **every** setting below validates:

```text
POST /v1/internal/shared-runtime-compiler/deployments/:id/grants
POST /v1/internal/shared-runtime-compiler/deployments/:id/upload-prepared
POST /v1/internal/shared-runtime-compiler/deployments/:id/published
POST /v1/internal/shared-runtime-compiler/deployments/:id/failed
```

Required Azure settings include this complete shared-node set:

```text
MONGO_CONNECION_STRING
BILLING_RATES_JSON
VULTR_API_TOKEN
VULTR_SHARED_NODE_REGION_ID
VULTR_SHARED_NODE_PLAN
VULTR_SHARED_NODE_IMAGE_ID
VULTR_SHARED_NODE_TOTAL_MEMORY_MIB
VULTR_SHARED_NODE_TOTAL_SHARED_CPU
VULTR_SHARED_NODE_TOTAL_WORKSPACE_GIB
XMCL_SHARED_AGENT_RELEASE_URL
XMCL_SHARED_AGENT_RELEASE_SHA256
XMCL_SHARED_QUOTA_HELPER_RELEASE_URL
XMCL_SHARED_QUOTA_HELPER_RELEASE_SHA256
XMCL_CONTROL_PLANE_URL
XMCL_VULTR_OBJECT_STORAGE_ENDPOINT
XMCL_VULTR_OBJECT_STORAGE_REGION
XMCL_VULTR_OBJECT_STORAGE_BUCKET
XMCL_VULTR_OBJECT_STORAGE_ACCESS_KEY
XMCL_VULTR_OBJECT_STORAGE_SECRET_KEY
XMCL_SHARED_NODE_CONTAINER_IMAGE
VULTR_SHARED_NODE_BLOCK_STORAGE_GIB
VULTR_SHARED_NODE_BLOCK_STORAGE_TYPE
VULTR_SHARED_NODE_FIREWALL_GROUP_ID
XMCL_SHARED_NODE_INGRESS_PORT_MIN
XMCL_SHARED_NODE_INGRESS_PORT_MAX
```

It also requires:

| Setting | Requirement |
| --- | --- |
| `CURSEFORGE_KEY` | Server-only reviewed CurseForge resolver key. |
| `XMCL_SHARED_COMPILER_ENDPOINT` | Exact HTTPS `https://…/v1/compiler-jobs`; no credentials, query, or fragment. |
| `XMCL_SHARED_COMPILER_KEY_ID` | HMAC workload identity key id (`[A-Za-z0-9][A-Za-z0-9._-]{0,127}`). |
| `XMCL_SHARED_COMPILER_HMAC_SECRET` | Secret of at least 32 UTF-8 bytes, stored only in Azure secret configuration and the compiler deployment. |
| `XMCL_SHARED_COMPILER_TIMEOUT_MS` | Server-owned bounded POST timeout from 1000 to 300000 ms. |
| `XMCL_SHARED_COMPILER_REVIEWED_IMAGE` | Approved immutable `ghcr.io/voxelum/xmcl-shared-minecraft-compiler@sha256:<64-hex>` deployment reference. |
| `XMCL_SHARED_RUNTIME_TERMS_VERSION` | Versioned Minecraft/EULA policy identifier. |

The separate trusted terms process must store a record in
`shared_runtime_terms_acceptances` with `_id`
`<accountId>:<serviceId>:<termsVersion>`, matching `accountId`, `serviceId`,
and `termsVersion`, `accepted: true`, and a valid `acceptedAt` ISO timestamp.
Neither a browser, compiler callback, nor node command can create that record.

The compiler identity is HMAC SHA-256 over exact raw bytes:

```text
METHOD\nPATH_AND_QUERY\nUNIX_MILLISECONDS\nNONCE\nSHA256(BODY)
```

Use `Authorization: HMAC <key-id>:<base64url signature>`,
`X-Xmcl-Timestamp`, and `X-Xmcl-Nonce`. Clocks allow ±60 seconds. Azure stores
each accepted nonce atomically in Mongo collection
`shared_runtime_compiler_nonces`. Cosmos Mongo supports TTL only on its internal
`_ts` field, so create a five-minute cleanup index before rollout. The
application's atomic nonce record and explicit `expiresAt` check enforce the
actual 60-second replay window; TTL is cleanup only:

```javascript
db.shared_runtime_compiler_nonces.createIndex({ _ts: 1 }, { name: "compiler_nonce_cleanup", expireAfterSeconds: 300 })
```

Do not log identity secrets, signed archive URLs, compiler grants, callback
bodies, or storage credentials. Browser imports receive only a short-lived
single-object immutable PUT. The control plane re-downloads that exact object
with a server-signed GET and verifies its declared size and SHA-256 before
validation. Compiler grants remain exactly one input GET and one
`If-None-Match: *` output PUT; they do not grant list, delete, world, node, or
master-storage access.

## Compiler protocol

`SharedModdedRuntimeService` freezes a canonical input manifest and calls a
`SharedModdedCompiler`. The compiler receives the service/account/deployment
identity, manifest digest, exact output key, validated config/data hashes,
resolved provider artifacts and hashes, and compiler request ID. It returns a
descriptor plus content archive descriptor only after the immutable PUT is
verified. Unknown compatibility, artifact hosts, digest mismatches, and
descriptors containing paths/arguments outside the fixed contract fail.
The descriptor must include the official `java.component`, `java.major`, and
`runtimeCatalog.sha256`; the control plane accepts only its compiled reviewed
catalog revision and a component/major requirement with a bundled runtime.
When the runtime-image catalog changes, regenerate the compact control-plane
catalog configuration from that reviewed lock and deploy it with the matching
immutable image digest; user uploads and compiler callbacks cannot select a
catalog URL or revision.

Before the immutable PUT, the authenticated compiler posts its exact reviewed
content digest and descriptor to `upload-prepared`. The control plane
validates and durably records that binding, then returns a GET grant for only
that output key. On timeout, response loss, or `412 If-None-Match: *`, the
worker uses the GET grant to hash and size-check the object against that
binding. It publishes only after that exact verification. If it cannot prove
the object, it returns HTTP 200 with `upload_reconciliation_uncertain`; the
deployment remains compiling and a redelivered job reuses the binding. It never
records a failed callback after upload preparation and never blindly publishes
an existing object.

After the immutable output PUT, the compiler can return HTTP 200 with
`published_callback_uncertain` if its published-callback response was lost. The
Azure adapter accepts that response only when its exact five-field schema binds
the current deployment and manifest. It durably records then reconciles the
same publication payload through the normal idempotent publish transition; it
never resubmits the job, rebuilds, or records a compiler failure. Other HTTP
200 response shapes are rejected.

The compiler callback endpoints are deliberately separate from account routes:

```text
POST /v1/internal/shared-runtime-compiler/deployments/:id/grants
POST /v1/internal/shared-runtime-compiler/deployments/:id/upload-prepared
POST /v1/internal/shared-runtime-compiler/deployments/:id/published
POST /v1/internal/shared-runtime-compiler/deployments/:id/failed
```

Platform middleware must authenticate the compiler and set
`sharedModdedCompilerPrincipal`; without it both endpoints reject requests.
The compiler may also report a structured `compile_failed` callback. This
durably marks only that deployment failed; it cannot alter selected content or
the current world revision.

## Release acceptance

Exercise Java 8 Forge, Java 16 Forge/Fabric, Java 17 Fabric, Java 21
NeoForge/Fabric, and a current Java 25 official-requirement fixture
through import, compile, publish, start, local health, external connect,
stop/sync, and restart on another node. Verify the customer container has no
outbound network and no storage credentials throughout.
