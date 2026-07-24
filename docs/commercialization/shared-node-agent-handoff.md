# Shared Hosting Go Node Agent Handoff

> **Superseded for workspace storage.** The v1 object-per-file/MinIO credential
> design below is retained only as historical context. The authoritative v2
> requirements are
> [`remediation/workspace-blob-presigned-url-handoff.md`](remediation/workspace-blob-presigned-url-handoff.md):
> the Worker owns Vultr credentials, agents receive only lease-bound exact
> pre-signed URLs, and agents have no S3 List, Delete, or static credential
> configuration.

## Goal

Implement a long-running **Go** daemon for each shared-hosting compute node.
It is the only component allowed to access:

- Docker Engine through `/var/run/docker.sock`
- node-local NVMe workspace directories
- Vultr Object Storage credentials (it exposes an S3-compatible API)

The Cloudflare/API control plane decides scheduling. The agent executes only
idempotent commands assigned to its own node and reports the result. It must
never make placement, billing, subscription, or cross-node migration decisions.

## Existing API-side contract

The API scheduler is already implemented in:

- `src/lib/sharedHostingScheduler.ts`
- `src/lib/sharedHosting.ts`
- `src/routes/sharedHostingServices.ts`

Important current types:

```ts
type SharedNodeCommand = {
  commandId: string
  kind: "workspace.restore_and_start" | "workspace.stop_and_sync"
  nodeId: string
  serviceId: string
  assignmentId: string
  accountId: string
  workspace: {
    objectPrefix: string
    revision: number
    sizeBytes: number
    sha256?: string
    syncedAt?: string
  }
  resources: {
    memoryMiB: number
    sharedCpu: number
    burstCpu: number
    workspaceGiB: number
  }
}
```

Scheduler invariants:

1. A service is assigned to one node only while `starting`, `running`, or
   `stopping`.
2. Services with status `ready`, `queued`, `failed`, or `deleted` consume no
   compute slot.
3. The scheduler applies hard capacity checks for memory, shared CPU, and local
   NVMe workspace capacity before dispatching a command.
4. Stop only releases a slot after the agent reports successful data sync.
5. Running containers are never migrated. A later start may be assigned to any
   node after a prior stop/sync completes.
6. `commandId` and `assignmentId` are idempotency boundaries. Replaying the
   same command must return the original terminal outcome and must not start a
   second container.

The user-facing API intentionally does **not** expose node IDs, object prefixes,
or storage credentials.

## Required implementation

Create a Go module/binary, suggested name `xmcl-shared-node-agent`, with:

```text
cmd/xmcl-shared-node-agent/main.go
internal/agent/
internal/docker/
internal/workspace/
internal/objectstore/
internal/controlplane/
internal/config/
```

Use Go 1.23 or newer. Run under `systemd` as a dedicated privileged service
account that can access Docker. Do not run it inside a shared Minecraft
container.

Recommended libraries:

- Docker Engine API: `github.com/docker/docker/client`
- Vultr Object Storage client: `github.com/minio/minio-go/v7` through its
  S3-compatible API
- Configuration: standard library plus a small YAML library if a config file is
  used
- Logging/metrics: structured JSON logging; Prometheus endpoint is preferred

Keep the agent independent from the API repository's TypeScript runtime.

## Command execution

### `workspace.restore_and_start`

The agent must:

1. Verify that `nodeId` equals its configured node identity.
2. Acquire a per-service filesystem lock. Reject a different active assignment;
   replay the same `commandId` idempotently.
3. Create a local workspace under a configured root, for example:

   ```text
   /var/lib/xmcl-shared/workspaces/<serviceId>
   ```

4. Download the canonical workspace revision from Vultr Object Storage. Do
   **not** mount object storage as a filesystem.
5. Verify the fetched manifest and every object hash before using the data.
6. Apply the local workspace quota before Docker starts.
7. Create or start exactly one container named:

   ```text
   xmcl-shared-<serviceId>
   ```

8. Apply the supplied resource limits:
   - `memoryMiB`: Docker memory hard limit. No swap by default.
   - `sharedCpu`: scheduling entitlement / CPU weight.
   - `burstCpu`: Docker maximum CPU quota. It must be at least `sharedCpu`.
   - `workspaceGiB`: hard local filesystem/project quota.
9. Use a non-root Minecraft process, read-only container image layers, a
   writable mounted workspace only, `no-new-privileges`, a PID limit, and no
   privileged mode or Docker socket mount.
10. Wait for the Minecraft process and agent health probe to become healthy.
11. Report `started` only after the container is genuinely usable.

The agent must report a failed restore/start if the manifest, quota, image,
Docker call, or health check fails. It must not claim the service is started
just because a container was created.

### `workspace.stop_and_sync`

The agent must:

1. Verify `nodeId`, `serviceId`, and `assignmentId`.
2. Send Minecraft a graceful stop command (RCON if configured; otherwise
   Docker `SIGTERM`), then enforce a timeout before a final kill.
3. Wait until the container is stopped and all world writes are flushed.
4. Create a new immutable workspace revision in object storage:

   ```text
   <objectPrefix>revisions/<revision>/...
   ```

5. Upload all data objects first. Publish `manifest.json` for that revision
   **last**, so an incomplete upload is never restorable.
6. The manifest must contain at least:

   ```json
   {
     "schemaVersion": 1,
     "serviceId": "shared_service_...",
     "assignmentId": "assignment_...",
     "revision": 1,
     "createdAt": "2026-07-24T00:00:00.000Z",
     "sizeBytes": 123,
     "sha256": "aggregate-or-manifest-hash",
     "files": [
       { "path": "world/level.dat", "sizeBytes": 123, "sha256": "..." }
     ]
   }
   ```

7. After all uploads and manifest publication succeed, report
   `stopped-and-synced` with the new revision, byte size, and manifest hash.
8. Remove the local workspace only after the control plane acknowledges the
   synced state, or retain it as an explicitly evictable cache. It must not
   continue consuming scheduler workspace capacity after that acknowledgement.

If sync fails, retain the local workspace, report failure, and retry safely.
Never report `stopped-and-synced` before object storage is durable.

## Object-storage requirements

Use **Vultr Object Storage**, not AWS S3. Vultr exposes an S3-compatible API,
which is why the Go client and some protocol terminology use "S3".

Required configuration:

```text
XMCL_SHARED_NODE_ID
XMCL_CONTROL_PLANE_URL
XMCL_CONTROL_PLANE_CREDENTIAL
XMCL_VULTR_OBJECT_STORAGE_ENDPOINT
XMCL_VULTR_OBJECT_STORAGE_REGION
XMCL_VULTR_OBJECT_STORAGE_BUCKET
XMCL_WORKSPACE_ROOT=/var/lib/xmcl-shared/workspaces
XMCL_STATE_ROOT=/var/lib/xmcl-shared/state
XMCL_CONTAINER_IMAGE
XMCL_RCON_STOP_TIMEOUT_SECONDS=60
XMCL_TOTAL_MEMORY_MIB
XMCL_TOTAL_SHARED_CPU
XMCL_TOTAL_WORKSPACE_GIB
XMCL_QUOTA_MOUNT_PATH=/var/lib/xmcl-shared
XMCL_QUOTA_PROJECT_BASE
```

Rules:

- The bucket must be private; do not make workspace objects public.
- Fetch temporary credentials from
  `XMCL_VULTR_OBJECT_STORAGE_CREDENTIAL_URL`; do not require static access or
  secret keys in cloud-init. The response is versioned, expires in at most
  fifteen minutes, and is restricted to `shared-hosting/` with
  `GetObject`, `PutObject`, and `ListBucket`.
- Never log Vultr Object Storage credentials, object contents, game secrets, RCON passwords, or
  signed URLs.
- Treat every object key as untrusted: reject absolute paths, `..`, and paths
  that escape the service workspace.
- Support retries and multipart upload for large modpacks/worlds.
- The authoritative workspace is object storage. Local NVMe is an execution
  workspace/cache, not the source of truth after successful sync.

## Control-plane transport

The TypeScript API exposes an authenticated, outbound-only HTTP transport at
`/v1/internal/shared-nodes`. It is not a public product route. All request and
response payloads use `contractVersion: 1`; reject a different version.

Implement the Go agent around two interfaces:

```go
type CommandSource interface {
    Next(ctx context.Context, nodeID string) (Command, error)
    Ack(ctx context.Context, commandID string, result CommandResult) error
}

type Reporter interface {
    Register(ctx context.Context, node NodeCapacity) error
    Heartbeat(ctx context.Context, status NodeStatus) error
    ReportStarted(ctx context.Context, serviceID, assignmentID string) error
    ReportStoppedAndSynced(ctx context.Context, result SyncResult) error
}
```

The wire endpoints are:

```text
POST /v1/internal/shared-nodes/register
POST /v1/internal/shared-nodes/{nodeId}/heartbeat
POST /v1/internal/shared-nodes/{nodeId}/commands:next
POST /v1/internal/shared-nodes/{nodeId}/commands/{commandId}/ack
POST /v1/internal/shared-nodes/{nodeId}/commands/{commandId}/lease-renew
POST /v1/internal/shared-nodes/{nodeId}/assignments/{assignmentId}/started
POST /v1/internal/shared-nodes/{nodeId}/assignments/{assignmentId}/stopped-synced
POST /v1/internal/shared-nodes/{nodeId}/object-storage-credentials
```

`ack` responds with `{ contractVersion, commandId, acknowledged,
leaseGeneration }`. Lease renewal sends a numeric `leaseGeneration` and
receives `{ contractVersion, leaseGeneration, leaseExpiresAt }`; preserve the
token and generation exactly until acknowledgement. A heartbeat sends
`status`, `agentVersion`, numeric `capacity` fields for free workspace,
allocatable memory/CPU, active containers, and `ingress.host`, the node's
approved public hostname.

The production transport must have:

- mutually authenticated node identity, preferably mTLS plus a short-lived
  signed node credential;
- timestamp, nonce, body hash, and replay protection for every mutation;
- strict node ownership checks;
- command acknowledgement and result idempotency;
- no inbound public port required on compute nodes. Outbound long-poll or
  authenticated WebSocket is preferred.

Each command now contains `connection: { host, hostPort }`, assigned and
durably reserved by the control plane before dispatch. Bind Docker to exactly
that host port; never hash a service ID or select a fallback port. Reject a
command without `connection` as incompatible. Include the exact assigned
endpoint in `started`; it becomes the trusted public-service projection.
Release the Docker binding only after successful `stopped-synced`; the
transport releases the reservation after accepting that callback.
The API defaults to the range `25565`–`25665`; configure
`XMCL_SHARED_NODE_INGRESS_PORT_MIN` and `XMCL_SHARED_NODE_INGRESS_PORT_MAX`
only when the node firewall and proxy use a different approved range.

## XFS quota boundary

Cloud-init mounts the dedicated XFS volume at `/var/lib/xmcl-shared` with
project quotas and installs root-owned `/usr/local/sbin/xmcl-apply-workspace-quota`.
The agent may invoke only that command through its narrowly scoped sudo rule:
`sudo /usr/local/sbin/xmcl-apply-workspace-quota <serviceId> <projectId> <GiB>`.
Do not bypass it, execute arbitrary quota commands, or start a container when
the helper fails.

## Node lifecycle

At startup:

1. Validate Docker daemon connectivity, Vultr Object Storage bucket access, workspace root,
   disk quota support, container image availability, and configured node
   capacity.
2. Register node capacity with the control plane:
   `totalMemoryMiB`, `totalSharedCpu`, and `totalWorkspaceGiB`.
3. Reconcile locally running `xmcl-shared-*` containers with outstanding
   assignments before accepting new commands.
4. Send heartbeats with disk free space, allocatable capacity, container count,
   and agent version.

Draining:

- Stop accepting new restore/start commands when instructed to drain.
- Do not stop active player services merely to drain.
- After all active services have synced and released their slots, report the
  node drain-ready so infrastructure can delete it.

## Observability

Emit structured logs with `nodeId`, `serviceId`, `assignmentId`, and
`commandId`. Redact credentials and workspace file contents.

Expose metrics for:

- active/starting/stopping containers
- allocated and available memory/CPU/workspace capacity
- restore and sync duration
- downloaded/uploaded bytes
- command successes/failures/retries
- workspace manifest verification failures
- Docker and Vultr Object Storage request latency/errors

## Required tests

At minimum implement:

1. Same `commandId` executes once even after process restart.
2. A different assignment for an active service is rejected.
3. Traversal paths in an object-storage manifest are rejected.
4. Hash mismatch prevents container start.
5. Stop does not release/ack the slot before manifest publication succeeds.
6. Failed sync leaves local data intact for retry.
7. Docker container has memory hard limit, CPU controls, workspace mount, no
   privileged mode, and no Docker socket mount.
8. A queued service can restore on a different node after a prior successful
   stop/sync.
9. Startup reconciliation handles an already-running container safely.

## Explicit non-goals

- Do not implement Kubernetes, Docker Swarm, or cross-node live migration.
- Do not run customer containers privileged.
- Do not store customer workspaces only on local NVMe.
- Do not decide pricing, bill users, or schedule placements in the agent.
- Do not expose Docker or object-storage admin endpoints to the public internet.
