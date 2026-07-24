# Remediation Handoff: Go Shared Node Agent and Object Storage

## Scope

Own only the Go repository:

```text
C:\Users\ci010-4090\Workspace\xmcl-shared-node-agent
```

This package owns Docker execution, local NVMe workspaces, Vultr Object Storage
transfer, agent daemon behavior, and the Go client for the control-plane
transport. Do not change TypeScript scheduler placement, billing amount
calculation, PayPal, or Vultr VM creation.

## Required fixes

### 1. Make configuration compatible with provisioning

The agent currently requires `XMCL_S3_*` and `XMCL_SHARED_NODE_ID`, while the
provisioner writes different names and omits most required values.

Adopt these canonical names:

```text
XMCL_SHARED_NODE_ID
XMCL_CONTROL_PLANE_URL
XMCL_CONTROL_PLANE_CREDENTIAL
XMCL_VULTR_OBJECT_STORAGE_ENDPOINT
XMCL_VULTR_OBJECT_STORAGE_REGION
XMCL_VULTR_OBJECT_STORAGE_BUCKET
XMCL_VULTR_OBJECT_STORAGE_ACCESS_KEY
XMCL_VULTR_OBJECT_STORAGE_SECRET_KEY
XMCL_WORKSPACE_ROOT
XMCL_STATE_ROOT
XMCL_CONTAINER_IMAGE
XMCL_RCON_STOP_TIMEOUT_SECONDS
XMCL_TOTAL_MEMORY_MIB
XMCL_TOTAL_SHARED_CPU
XMCL_TOTAL_WORKSPACE_GIB
XMCL_QUOTA_MOUNT_PATH
XMCL_QUOTA_PROJECT_BASE
XMCL_METRICS_ADDR
```

Update `internal/config`, README, systemd examples, and tests together. The
control-plane/provisioning agent will update cloud-init to match this exact
contract.

### 2. Implement the authenticated control-plane client

Replace `UnconfiguredSource` and `UnconfiguredReporter` in
`cmd/xmcl-shared-node-agent/main.go`.

Implement an outbound HTTPS long-poll client for the internal API routes:

```text
POST /v1/internal/shared-nodes/register
POST /v1/internal/shared-nodes/{nodeId}/heartbeat
POST /v1/internal/shared-nodes/{nodeId}/commands:next
POST /v1/internal/shared-nodes/{nodeId}/commands/{commandId}/ack
POST /v1/internal/shared-nodes/{nodeId}/assignments/{assignmentId}/started
POST /v1/internal/shared-nodes/{nodeId}/assignments/{assignmentId}/stopped-synced
POST /v1/internal/shared-nodes/{nodeId}/commands/{commandId}/lease-renew
```

Use the exact request signing scheme from
`xmcl-web-api/src/lib/sharedNodeTransport.ts`:

```text
METHOD + "\n" + PATH + "\n" + TIMESTAMP_MS + "\n" + NONCE + "\n" + SHA256(BODY)
```

Send:

```text
Authorization: SharedNode <nodeId>.<credential>
X-XMCL-Timestamp
X-XMCL-Nonce
X-XMCL-Body-SHA256
X-XMCL-Signature
```

The initial registration uses the one-time bootstrap credential with
`Authorization: SharedNode-Bootstrap <credential>`. Persist the issued
short-lived node credential with mode `0600`; handle credential rotation from
registration/renewal response.

Do not open an inbound HTTP control port on a node. Verify TLS certificates; do
not implement insecure TLS bypass flags.

### 3. Implement heartbeats, retry, and graceful daemon operation

- Send heartbeats on a fixed cadence shorter than the server heartbeat timeout.
- Report free workspace capacity, active container count, agent version, and
  drain-ready state.
- Retry transient long-poll, ACK, report, Docker, and object-storage failures
  with bounded exponential backoff and jitter.
- Do not terminate the daemon permanently on a transient control-plane error.
- Handle SIGTERM/SIGINT: stop accepting new commands, finish/retry durable
  state safely, and exit only after the configured grace period.

### 4. Fix command execution leases

The control-plane agent will provide a lease token/generation and lease renewal
endpoint. Store it with each in-progress command.

- Renew the lease throughout restore, health wait, stop, and sync.
- Never ACK with a stale lease token.
- If lease renewal is denied, stop further irreversible work and report a
  retryable failure; do not release a workspace or claim success.

### 5. Support initial empty workspaces

New shared services start with workspace revision `0` and no manifest. Restore
must create an empty safe workspace in this case rather than fail on a missing
`manifest.json`.

For revision greater than zero, a valid manifest remains mandatory.

### 6. Make object transfer streaming and bounded

Current `io.ReadAll`/`os.ReadFile` behavior can load a world or modpack fully
into memory. Replace it with:

- streaming S3 download directly to a staged file;
- streaming SHA-256 verification;
- streaming/multipart uploads from local files;
- configured maximum manifest size, per-file size, total workspace size, and
  concurrency;
- cleanup of partial local staging and partial multipart uploads.

The manifest is still written last. A failed upload must retain the local
workspace and current assignment for retry.

### 7. Provide a reachable Minecraft ingress

The current Docker create request has no published port, network policy, or
proxy integration. Implement one approved design:

1. Attach containers to a dedicated private Docker network and register the
   assigned service port with a node-local TCP proxy; or
2. Allocate an explicit host port with Docker port bindings and have the
   control plane proxy/DNS layer route to it.

The implementation must:

- never expose Docker API;
- allocate ports deterministically per active assignment;
- remove routing/port binding only after stop/sync acknowledgement;
- report connection endpoint metadata only to the trusted control plane, never
  public logs.

### 8. Make quota application actually executable

`xfs_quota -x project/limit` generally needs privileged filesystem access; the
current unprivileged `xmcl-agent` systemd user is unlikely to perform it.

Choose one secure design:

- a root-owned, tightly scoped quota helper invoked through a restricted
  privilege boundary; or
- run only quota application through a dedicated root system service with
  authenticated local IPC.

Do not give the Minecraft container privileges. Fail closed if the hard quota
cannot be applied.

## Required tests

1. New revision-0 service restores an empty workspace successfully.
2. Large restore/sync uses bounded memory; test with a streaming fake store.
3. Lease renewal occurs during a long sync; stale ACK is not sent.
4. Transient control-plane failure retries without terminating daemon.
5. Agent sends heartbeat after registration.
6. Docker configuration has a reachable game ingress but no Docker socket,
   privilege, or writable root filesystem.
7. Quota helper path cannot execute arbitrary commands or choose arbitrary
   directories.
8. Configuration uses only the canonical `XMCL_VULTR_OBJECT_STORAGE_*` names.

## Acceptance

The binary must register with a fake signed control plane, execute a full
restore/start/stop/sync cycle, survive a simulated restart and long upload, and
leave no user data or credential in logs.
