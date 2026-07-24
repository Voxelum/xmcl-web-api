# Remediation Handoff: Shared Control Plane and Vultr Provisioning

## Scope

Own TypeScript control-plane transport and shared-node provisioning in:

```text
C:\Users\ci010-4090\Workspace\xmcl-web-api
```

Primary files:

- `src/lib/sharedNodeTransport.ts`
- `src/routes/sharedNodeTransport.ts`
- `src/lib/sharedNodeProvisioner.ts`
- `src/lib/sharedHostingScheduler.ts`
- `cloudflare/worker.ts`
- production composition/configuration files

Do not implement Docker/S3 file transfer in this package; the Go agent owns it.

## Required fixes

### 1. Replace global bootstrap token with one-time enrollment

The current shared bootstrap token can enroll arbitrary node IDs and overwrite
an existing node credential.

Implement a durable provisioning-bound enrollment record containing:

```text
nodeId
provisioningRequestId
instanceId
expectedCapacity
oneTimeTokenHash
expiresAt
consumedAt
```

Rules:

- Generate a unique one-time bootstrap token per Vultr VM.
- Cloud-init receives only its own token.
- Registration atomically verifies node ID, expected capacity, token hash,
  expiry, and unused state before issuing a node credential.
- Registration consumes the token; it cannot enroll a second node.
- Existing active node credentials cannot be overwritten by a bootstrap request.

### 2. Make command leases safe for long operations

The current 60-second lease expires before a normal workspace restore or sync,
and ACK does not bind to an individual lease generation.

Add:

```text
leaseToken
leaseGeneration
leaseExpiresAt
```

to outbox delivery. `commands:next` returns these values. Add:

```text
POST /v1/internal/shared-nodes/{nodeId}/commands/{commandId}/lease-renew
```

Requirements:

- ACK and renewal require current `leaseToken`/generation in an atomic Mongo
  predicate.
- An expired or redelivered lease cannot be ACKed by an old executor.
- Renewal has a bounded maximum command lifetime and audit record.
- Requeue only when the lease is genuinely expired.
- Do not hold a Cloudflare request open while the Go agent performs restore or
  sync.

### 3. Finish production composition

Currently production mounts billing routes only. It does not construct or inject
the shared scheduler, outbox, transport, provisioner, or scheduled work.

Add a dedicated production composition that creates per-request/shared durable
adapters using:

- `MongoSharedHostingSchedulerRepository`
- `MongoSharedNodeCommandOutbox`
- `MongoSharedNodeCredentialRepository`
- `MongoSharedNodeProvisioningRepository`
- `DurableSharedNodeCommandGateway`
- `SharedNodeTransportService`
- `VultrSharedNodeProvisioner`
- `SharedHostingScheduler`
- `BillingRuntime.sharedHosting`

Keep public shared-hosting user routes disabled until payment and agent
acceptance are complete. Internal node routes should be mounted only when all
required shared-node settings exist; otherwise fail closed with `503`.

### 4. Fix cloud-init bootstrap

`renderSharedNodeCloudInit` must generate the exact configuration required by
the Go agent remediation handoff:

- canonical `XMCL_SHARED_NODE_ID` and
  `XMCL_VULTR_OBJECT_STORAGE_*` names;
- one-time enrollment credential in `XMCL_CONTROL_PLANE_CREDENTIAL`;
- S3 endpoint/bucket/credential acquisition strategy;
- container image, timeout, workspace/state root, XFS quota mount/project base;
- correct `/var/lib/xmcl-shared/...` paths;
- root-owned `0600` config;
- agent binary checksum verification;
- systemd hardening and any quota-helper installation.

Do not place long-lived global bootstrap tokens, customer data, Docker socket
credentials, or S3 master credentials in labels or user-visible metadata.

### 5. Make provisioning asynchronous

`SharedHostingScheduler.start` must not wait for VM provisioning and agent
registration in the user request. It should enqueue a durable capacity request
and return `queued`.

The provisioner/scheduled worker should:

1. claim a capacity request;
2. create/reconcile VM;
3. wait for registration asynchronously;
4. mark node ready;
5. let scheduler dispatch queued commands.

Use durable status records, retries, timeouts, and reconciliation labels.

### 6. Implement node lifecycle and stale recovery

- Heartbeat sweep marks node offline but preserves unknown active workspaces.
- Draining blocks new assignments, sends stop/sync, waits for confirmations,
  then deletes VM.
- Do not delete a node with unconfirmed active data.
- Handle agent registration after a provisioning timeout as a reconciliation
  event, not a duplicate VM create.

## Required tests

1. One-time enrollment cannot register arbitrary/repeated node IDs.
2. Existing node credential cannot be replaced by bootstrap registration.
3. Old lease ACK cannot acknowledge a redelivered command.
4. Long command lease renewal prevents requeue.
5. User start request returns promptly while provisioner works asynchronously.
6. Cloud-init contains every canonical agent setting and no master secret.
7. Production composition mounts internal transport only with complete settings.
8. Node drain does not delete VM until every active service has synced.

## Acceptance

Use a fake Vultr adapter and fake signed Go-agent client to prove:

```text
queued service -> capacity request -> VM create -> one-time registration
-> command lease -> started -> stop/sync -> slot release -> node drain/delete
```

No public endpoint may enroll nodes or fetch commands.
