# Shared workspace blobs and pre-signed URL broker handoff

## Ownership and scope

This is one cohesive cross-repository work package. Modify only the following
repositories:

- `C:\Users\ci010-4090\Workspace\xmcl-web-api`
- `C:\Users\ci010-4090\Workspace\xmcl-shared-node-agent`

Own the canonical shared-workspace serialization format and the authenticated
command-scoped object-storage transfer protocol. Do **not** change billing,
subscription renewal, placement/capacity policy, Vultr VM provisioning, node
enrollment, Docker resource isolation, or public user routes.

The existing long-lived/per-node storage credential design must be removed from
the node-agent runtime. Do not ship a compatibility fallback that lets an agent
use a Vultr access key, secret key, S3 List operation, or arbitrary object
key. Public shared-hosting routes must remain disabled.

## Decisions that are already final

1. The storage provider is **Vultr Object Storage** using its S3-compatible
   API; it is not AWS storage.
2. The Worker/control plane owns the durable Object Storage signing credential.
   The Go node agent never receives, persists, logs, or configures that key.
3. Agents transfer bytes directly to/from Vultr via short-lived S3 SigV4
   pre-signed URLs. The Worker is never a data proxy.
4. Every grant is bound to the authenticated `nodeId`, `commandId`,
   `assignmentId`, lease token, lease generation, service workspace prefix,
   revision, exact object keys, HTTP method, and expiration.
5. Workspaces are packaged by **mutability**, not as one object per local file:
   - `world` data is split into independently restorable `.tar.zst` blobs.
   - `config` and mod configuration are one `.tar.zst` blob.
   - relatively fixed runtime content (mods, scripts, packs and comparable
     deployment content) is an immutable, digest-addressed content blob (or
     small fixed set of blobs), reused by later revisions while unchanged.
6. A revision is immutable and becomes visible only when its `manifest.json`
   is published **last**. Existing published manifests and blobs may never be
   overwritten.
7. A compromised node may at worst access the short-lived, exact blobs of its
   current command. It must not list, read, overwrite, or delete any other
   service's objects.

## Canonical object layout

Keep the existing canonical service prefix:

```text
shared-hosting/<accountId>/<serviceId>/
```

Within it, use this v2 layout:

```text
content/<sha256>.tar.zst
revisions/<revision>/world/<shard-id>.tar.zst
revisions/<revision>/config.tar.zst
revisions/<revision>/manifest.json
```

`manifest.json` must be versioned (`schemaVersion: 2`) and include:

- service ID, assignment ID, revision, creation time, logical size and
  manifest hash;
- immutable content blob digest/key/size/hash;
- config blob key/size/hash if present;
- a stable ordered list of world shards with key, logical paths, compressed
  size and SHA-256;
- the complete local-path mapping needed for safe restore;
- an aggregate digest over all manifest blob descriptors.

Do not include access keys, pre-signed URLs, or private game/config contents in
the manifest.

### Classification and sharding

Use explicit, documented path classification. At minimum:

- `world/`, `world_nether/`, and `world_the_end/` are world data. Split at
  safe directory boundaries such as region groups and dimensions, with a
  bounded target compressed blob size (for example 128--256 MiB). Never split
  a local file across path records ambiguously.
- `config/` and `defaultconfigs/` form the config layer.
- `mods/`, `kubejs/`, `scripts/`, `resourcepacks/`, and server bootstrap
  content form the immutable content layer. Select a conservative documented
  default for other files; it must not accidentally omit user data.

The first sync may create a content blob. Subsequent stop/sync operations must
reuse the prior content digest when its canonical content tree is unchanged.
Changed content creates a new digest-addressed object; it never overwrites the
old blob. Content sharing across different services is out of scope unless the
authorization model explicitly grows to support it.

Use streaming archive/compression and extraction. Enforce total workspace,
per-blob, manifest, path, symlink, traversal, duplicate-entry, and decompressed
size limits. Extraction must occur in a staging directory and atomically
replace the active workspace only after all hashes validate.

## Pre-signed transfer broker

Replace the current internal
`/object-storage-credentials` endpoint and
`SHARED_NODE_OBJECT_STORAGE_CREDENTIALS` issuer concept with authenticated
grant endpoints. A Worker-side signer configuration is allowed, but it must
never be exposed to the agent.

Use one versioned request/response protocol. Use signed node HTTP requests
with the existing exact-body HMAC authentication and require:

```text
contractVersion: 2
commandId
assignmentId
leaseToken
leaseGeneration
```

The control plane must verify that the command is currently leased to that
node, has the supplied token and generation, is not expired/acknowledged, and
has the requested operation compatible with its command kind.

Suggested endpoint family:

```text
POST /v1/internal/shared-nodes/:nodeId/workspace-grants/restore
POST /v1/internal/shared-nodes/:nodeId/workspace-grants/sync
POST /v1/internal/shared-nodes/:nodeId/workspace-grants/publish
```

Exact URL shapes may differ, but all grants must satisfy the following:

### Restore grants

1. `restore_and_start` receives a pre-signed GET for exactly its published
   manifest.
2. After parsing it, the agent requests GET grants for the manifest's exact
   blob keys. The control plane confirms that all requested descriptors belong
   to the assigned published manifest and returns URLs only for those keys.
3. Agents must not receive List, Delete, bucket-level, or arbitrary-key URLs.

### Sync grants

1. `stop_and_sync` may request PUT grants only for its next revision:
   `command.workspace.revision + 1`.
2. The control plane validates every submitted v2 blob descriptor:
   service prefix, revision, layer/key convention, digest format, bounded
   count/size, and no duplicate key. It does not issue overwriting grants for
   an existing published revision or immutable content digest.
3. URL lifetime must be short (target 10 minutes; configurable bounded maximum
   of 15 minutes). Multipart uploads require a bounded, explicit sequence of
   signed create/upload-part/complete operations. Do not revert to a general
   credential to implement multipart.
4. The agent uploads blobs directly to Vultr, hashes while streaming, then
   submits the manifest descriptor to `publish`.
5. `publish` revalidates command/lease/assignment and blob descriptors and
   returns a pre-signed PUT only for the one manifest object. The agent writes
   that object last, then reports `stopped-and-synced`.

The broker should enforce HTTPS endpoints and strict signer-region/bucket
configuration. Write no credentials, signed URLs, game data, or full manifest
contents to logs. Errors must be explicit and typed; no fallback to static
credentials.

## S3 SigV4 signer requirements

Implement an S3-compatible SigV4 pre-signer usable in Cloudflare Workers,
without Node-only crypto, dynamic evaluation, AWS SDK assumptions, or external
byte proxying. It must support:

- GET and PUT exact-object URLs;
- canonical URI/query/header construction compatible with Vultr Object Storage;
- expiration and host validation;
- `UNSIGNED-PAYLOAD` only where Vultr's S3-compatible behavior supports it;
- deterministic tests with fixed clock and fixture credential;
- no long-lived key exposure in JSON responses, exceptions, or logs.

Provide the Worker-side signer via explicit server-only configuration/binding.
Document every required secret and binding, and make production composition
keep transport routes unmounted when this signer is absent.

## Go agent requirements

Replace the current static MinIO credential client path with a grant-backed
HTTP transfer client:

- It requests grants only while processing its current leased command.
- It follows only HTTPS URLs and validates the expected Vultr storage host,
  object key association, response status, byte count and SHA-256.
- It does not follow arbitrary redirects or send its control-plane credential
  to Object Storage.
- It uses bounded concurrency, streaming GET/PUT, retry-safe requests, and
  context cancellation.
- It neither lists nor deletes Object Storage keys.
- It has no `XMCL_VULTR_OBJECT_STORAGE_ACCESS_KEY`,
  `XMCL_VULTR_OBJECT_STORAGE_SECRET_KEY`, or
  `XMCL_VULTR_OBJECT_STORAGE_CREDENTIAL_URL` production configuration.

Persist only command execution/idempotency state already required by the
daemon. Do not persist grants or URLs. A stopped-sync retry must either reuse
the already published manifest for the same assignment/revision or obtain new
grants safely; it may not create an alternate completed revision.

## Required tests

Web API:

- exact signed request body and lease validation for every grant endpoint;
- expired, stale, wrong-node, wrong-assignment, wrong-generation and
  acknowledged-command denial;
- no cross-service/prefix/revision/key escalation;
- manifest-last publication and no overwrite of published objects;
- deterministic SigV4 fixture validates method, canonical key and expiry;
- production composition remains closed without a real signer binding.

Go agent:

- restore uses only granted exact GET URLs and rejects a malicious/foreign URL;
- sync uploads world/config/content blobs according to classification;
- an unchanged content layer reuses its digest without upload;
- changed world shard uploads only its replacement layer;
- archive path, duplicate, symlink, oversized and decompression-bomb inputs
  are rejected;
- manifest is published last;
- no request uses static storage credentials, List, or Delete;
- interrupted transfer/retry does not create a second completed revision.

Run `gofmt`, `go test ./...`, and `go vet ./...` in the Go repository; run
the smallest relevant Deno test files and `deno check` in the API repository.

## Documentation deliverable

Update the relevant deployment and agent documentation with:

- exact Worker binding/secrets required for the S3 signer;
- the fact that agents receive grants, not Object Storage credentials;
- the v2 manifest/blob layout and compatibility policy;
- a staged validation sequence:
  `VM enroll -> restore revision -> start -> stop -> upload blobs ->
  publish manifest -> report sync -> slot release -> restore on another node`.

Do not claim production readiness until this staging sequence runs against a
real Vultr bucket and VM.
