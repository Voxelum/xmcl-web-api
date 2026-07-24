# Handoff: Shared Vultr Node Provisioning and Autoscaling

## Goal

Implement `SharedNodeProvisioner` so the scheduler can create, bootstrap,
drain, and delete shared compute nodes on Vultr.

The current authenticated Vultr account cannot use Taipei (`tpe`) Compute or
Object Storage. Singapore (`sgp`) is the active shared-node staging and
production pool. A future multi-region product needs explicit region selection
and a cross-region data policy; it is out of scope.

## Existing code

- Capacity request interface: `SharedNodeProvisioner` in
  `src/lib/sharedHostingScheduler.ts`
- Current Vultr adapter: `src/lib/vultr.ts`
- Dedicated server lifecycle: `src/lib/serverControl.ts`
- Go agent contract: `docs/commercialization/shared-node-agent-handoff.md`

Do not reuse customer dedicated-server instances as shared nodes.

## Required delivery

1. Define approved shared-node VM profiles. Initial profile should reserve
   system capacity, expose node memory/CPU/workspace capacity, and contain no
   customer-specific state.
2. Implement capacity-request deduplication on `requestId`.
3. Create a Vultr VM in Singapore with cloud-init user data that:
   - installs Docker;
   - creates the restricted node-agent service account;
   - installs/verifies the Go agent artifact;
   - writes only root-readable agent configuration;
   - enables and starts systemd service `xmcl-shared-node-agent`;
   - never stores user Minecraft data in the image.
4. Wait for the agent's authenticated node registration before considering the
   VM schedulable.
5. Implement drain lifecycle: mark scheduler node `draining`, accept no new
   assignments, wait for all active services to stop/sync, then delete VM.
6. Apply Vultr tags and labels that identify environment, region, node pool,
   and capacity request ID for reconciliation.

## Security and operations

- Use a dedicated Vultr API token with only required instance/snapshot/network
  permissions.
- Do not place Docker socket, Vultr Object Storage keys, or node credentials in instance labels,
  user-visible metadata, logs, or API responses.
- Restrict inbound network: no public Docker API, no public agent admin port.
- Prefer agent-initiated outbound control-plane connection.
- Reconcile unknown creation outcomes using labels/tags before retrying create.
- Never delete a node with a service still in `starting`, `running`, or
  `stopping` unless an explicit incident workflow has preserved data.

## Required configuration

```text
VULTR_API_TOKEN
VULTR_SHARED_NODE_REGION_ID=sgp
VULTR_SHARED_NODE_PLAN
VULTR_SHARED_NODE_IMAGE_ID
XMCL_SHARED_AGENT_RELEASE_URL
XMCL_SHARED_AGENT_RELEASE_SHA256
XMCL_CONTROL_PLANE_URL
VULTR_SHARED_NODE_BLOCK_STORAGE_GIB
VULTR_SHARED_NODE_BLOCK_STORAGE_TYPE
VULTR_SHARED_NODE_FIREWALL_GROUP_ID
XMCL_SHARED_NODE_INGRESS_PORT_MIN
XMCL_SHARED_NODE_INGRESS_PORT_MAX
```

Current Singapore staging values are:

```text
VULTR_SHARED_NODE_REGION_ID=sgp
XMCL_VULTR_OBJECT_STORAGE_ENDPOINT=https://sgp1.vultrobjects.com
XMCL_VULTR_OBJECT_STORAGE_REGION=sgp
XMCL_SHARED_NODE_REGION=sgp  # cloud-init owned; operators do not set it manually
```

Use platform secret storage for every secret. The API must keep commercial
routes disabled until these values and node transport are complete.

`VULTR_SHARED_NODE_BLOCK_STORAGE_GIB` is a positive integer. It must cover the
selected node profile's advertised workspace capacity and leave operational
headroom for workspace restore, archive, and sync staging. It has no default.
`VULTR_SHARED_NODE_BLOCK_STORAGE_TYPE` must be an approved Vultr Block Storage
class (`high_perf` or `storage_opt`) and also has no default. Larger volumes and
the higher-performance class increase Vultr Block Storage charges; select them
deliberately for the expected concurrent workspace and I/O load.

Do not configure a Linux disk path. The platform creates the volume in the
node's configured Vultr region and cloud-init receives only its Vultr volume
ID. The node resolves that ID through `/dev/disk/by-id`, rejects the root disk,
and mounts the verified XFS volume with project quotas at
`/var/lib/xmcl-shared`.

## Shared-node Firewall Group

Before enabling production shared-node transport, an operator must pre-create
one long-lived Vultr Firewall Group exclusively for the shared-node pool. Set
its provider ID as `VULTR_SHARED_NODE_FIREWALL_GROUP_ID`; it is server-only
Worker configuration and must never be accepted from a browser request. The
control plane attaches this group only in the initial VM create request. It
never creates, deletes, attaches later, or repairs a group.

Set `XMCL_SHARED_NODE_INGRESS_PORT_MIN` and
`XMCL_SHARED_NODE_INGRESS_PORT_MAX` to explicit integers from `1024` through
`65535`, with min no greater than max. Configure exactly the same range in the
control-plane scheduler and the group's sole inbound rule:

```text
IPv4 TCP <min>:<max> from 0.0.0.0/0
```

Size the range for the maximum planned concurrent Minecraft services per node.
Do not permit SSH (22), metrics (9464), Docker (2375/2376), RCON,
control-plane internals, storage, or catch-all inbound traffic. Leave IPv6
unassigned/disabled for shared-node VMs unless a reviewed equivalent IPv6
ingress model is implemented. Agent-to-Worker and agent-to-Vultr Object Storage
use outbound HTTPS and require no inbound exception.

## Block Storage lifecycle and cleanup

The Block Storage volume is node-local execution and cache capacity. Canonical
workspace data remains in Vultr Object Storage, so a volume is eligible for
destruction only after every active service has successfully stopped and synced
its canonical revision.

For each capacity request, the control plane persists a deterministic
`xmcl-shared-volume-<request-id>` record before VM creation. It reconciles the
label, region, size, and type on retries; it does not replace an uncertain
volume. After VM creation it attaches that exact volume and waits for the
provider to report the expected instance attachment before the node can enroll.

Drain first prevents new assignments and waits for every stop-and-sync report.
Only then does the control plane delete the VM, confirm or request Block
Storage detachment, and delete the request-owned volume. A timeout, unknown
provider result, or unconfirmed sync retains the durable provisioning record
for reconciliation and blocks deletion. Detached/deleted volumes stop their
recurring Block Storage billing; orphaned or unknown volumes require operator
reconciliation rather than blind cleanup.

Before accepting this flow with a real provider, perform a staged Vultr test:

```text
capacity request -> volume create -> VM create -> volume attach ->
volume setup succeeds -> node enrolls -> drain -> stop/sync ->
VM delete -> volume detach/delete
```

This repository's tests validate request construction and reconciliation only;
they do not claim staging or production readiness until that staged flow has
run against real Singapore Vultr resources.

For firewall acceptance, additionally inspect the VM `firewall_group_id`,
confirm only the allowed port range is reachable, verify metrics/SSH/Docker/RCON
are unreachable, start one service on a reserved port and connect to it, then
stop it and verify that port no longer accepts a Minecraft connection. Do not
claim production readiness until this runs against an actual Vultr VM.

## Tests required

1. Duplicate capacity requests create one node.
2. Definitive provider failure produces no retry; unknown outcome reconciles by
   label/tag before retry.
3. Node is not marked `ready` before authenticated agent registration.
4. Draining node receives no new assignments.
5. Node deletion occurs only after all workspace sync confirmations.
6. Cloud-init fixture contains no user/service data or secret values.
