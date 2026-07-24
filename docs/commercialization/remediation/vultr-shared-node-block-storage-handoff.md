# Vultr shared-node Block Storage handoff

## Scope

Own a single independent work package in:

```text
C:\Users\ci010-4090\Workspace\xmcl-web-api
```

Implement automatic lifecycle management for the **ephemeral local workspace
disk** on shared compute nodes:

```text
create Vultr Block Storage -> create VM -> attach volume -> boot-time verified
mount/XFS quota setup -> agent registration -> drain -> detach/delete volume
```

The canonical server data remains in Vultr Object Storage. This Block Storage
volume is node-local execution/cache capacity and may be destroyed only after
the scheduler has received successful stop-and-sync reports for every active
service.

Do not change billing, shared workspace blob/pre-signed URL work, node
transport, public routes, Go archive protocol, or product UI. Do not broaden
the generic dedicated-server `VultrAdapter` interface in a way that forces
unrelated dedicated-server fakes to implement shared-node volume methods.

## Problem to solve

`XMCL_XFS_DEVICE=/dev/vdb` is unsafe and must be removed from deployment
requirements. Linux device names can change, and blindly formatting `/dev/vda`
would destroy the operating-system disk.

Vultr Block Storage should instead be provisioned and identified by its Vultr
volume ID through its stable Linux `/dev/disk/by-id` symlink. For a volume ID
such as `vol-abc`, Vultr commonly exposes a symlink shaped like:

```text
/dev/disk/by-id/scsi-0Vultr_Block_Storage_vol-abc
```

Never rely on `/dev/vdb`, `/dev/vdc`, discovery by “first non-root disk”, or
the textual order of `lsblk`.

## Provider contract

Add a **shared-node-specific** volume provider contract, implemented by
`VultrV2Adapter` but injected separately into `VultrSharedNodeProvisioner`.
The real API implementation must use the documented Vultr v2 Block Storage
endpoints:

```text
POST   /v2/block-storage
GET    /v2/block-storage/{block-id}
GET    /v2/block-storage?label=...
POST   /v2/block-storage/{block-id}/attach
POST   /v2/block-storage/{block-id}/detach
DELETE /v2/block-storage/{block-id}
```

Use the provider’s documented field names (`region`, `size_gb`, `label`,
`block_type`, `instance_id`, and `live` where applicable). Parse and verify:

```text
id
region
size_gb
label
status
attached_to_instance
```

Classify definitive rejection, unknown provider outcome, malformed response,
and unavailable/timeout consistently with existing `VultrError` behavior.
Do not guess successful attachment merely from a 2xx response: poll/read the
volume until `attached_to_instance` is the intended instance ID before
considering it ready.

## Configuration

Replace the required `XMCL_XFS_DEVICE` production setting with:

```text
VULTR_SHARED_NODE_BLOCK_STORAGE_GIB
VULTR_SHARED_NODE_BLOCK_STORAGE_TYPE
```

Requirements:

- `VULTR_SHARED_NODE_BLOCK_STORAGE_GIB` is a positive integer and must be at
  least the selected node profile’s `totalWorkspaceGiB`; leave sufficient
  capacity for staging/archive work. It has no silent default.
- `VULTR_SHARED_NODE_BLOCK_STORAGE_TYPE` is an explicitly allowlisted Vultr
  block type (for example `high_perf` or `storage_opt`), with no silent
  provider default.
- The volume must be created in the same configured Vultr region as its VM.
- Both settings are required before shared-node production composition can
  mount internal node transport.
- The agent config continues to receive only the existing workspace root and
  quota mount path. It does **not** receive a raw device name.

Document the operational cost trade-off of volume size/type. Do not hardcode a
production size in code.

## Durable record and reconciliation

Extend `SharedNodeProvisioningRecord` with durable, request-bound volume state:

```text
volumeId
volumeLabel
volumeSizeGiB
volumeStatus: creating | attaching | attached | detaching | deleted | unknown
```

Use deterministic labels based on the capacity `requestId`, distinct from VM
labels, such as:

```text
xmcl-shared-volume-<safe-request-id>
```

Rules:

1. Create/persist the volume record before VM creation. A retry must reconcile
   by deterministic label, region, size/type, and ownership metadata rather
   than create a second volume.
2. Create the VM with cloud-init that is safe to start before the volume is
   attached.
3. Attach the exact durable volume to the exact durable VM. Persist
   `attaching`, then confirm attachment before setting `attached`.
4. Unknown provider outcomes must reconcile both VM and volume. Never create a
   replacement volume while a matching existing resource may exist.
5. On a definitive volume provision/attach failure, record a definitive
   failure. Clean up only resources proved to belong to this request; preserve
   an unknown resource for reconciliation rather than deleting blindly.
6. During node drain, invoke scheduler drain and wait until there are no active
   services. Then delete the VM, wait/reconcile detachment, and delete the
   request-owned volume. If any step is unknown, retain the durable record as
   `unknown`; do not report the capacity request as safely deleted.
7. Never detach/delete a volume while an active or unconfirmed assignment
   remains.

## Cloud-init and systemd bootstrap

The existing cloud-init must no longer format a configured `/dev/...` path.
Instead it receives a validated, non-secret `XMCL_SHARED_NODE_VOLUME_ID`.

Install a root-owned volume setup script and a systemd unit such as
`xmcl-shared-volume-setup.service` with these properties:

1. It runs before `xmcl-shared-node-agent.service`; the agent has
   `Requires=` and `After=` on it.
2. It waits with a bounded timeout for exactly one `/dev/disk/by-id` entry
   matching the expected Vultr Block Storage volume ID. Reject no match,
   multiple matches, unexpected symlink targets, or unsafe ID syntax.
3. It verifies the resolved block device is not the root filesystem’s source
   and is not currently mounted elsewhere.
4. Only a fresh request-owned volume may be formatted. If an XFS filesystem
   already exists, it must carry a root-owned marker containing the same volume
   ID and expected mount path; otherwise fail closed. Never reformat a
   non-empty/unrecognized disk.
5. It creates XFS with project quota support, mounts the volume at
   `/var/lib/xmcl-shared` using its filesystem UUID and `pquota`, writes the
   marker, and creates the root-owned bootstrap/config plus
   `xmcl-node-agent` workspace/state directories.
6. It fails hard if the expected volume is not attached in time. The agent
   must not register a schedulable node with the root filesystem as its
   workspace.

The existing quota helper configuration must point at that mount only. Keep
the helper root-owned and its configuration non-writable by the node agent.

## Required tests

Add focused Deno tests with a fake volume provider:

1. Volume is created once, persisted, then attached to the created VM before
   node registration is accepted.
2. Retry/restart reconciles a matching volume and does not create duplicates.
3. Wrong region, wrong size/type, wrong attachment target, malformed provider
   response, and unknown outcomes fail safely.
4. Drain refuses deletion with active services; successful drain deletes VM,
   confirms detach, then deletes only the request-owned volume.
5. Cloud-init contains volume ID, stable `/dev/disk/by-id` selection, root disk
   rejection, bounded wait, XFS/pquota mount, and systemd ordering; it contains
   no `XMCL_XFS_DEVICE` or `/dev/vdb` assumption.
6. Production composition remains disabled unless both volume settings are
   valid.

Run the smallest relevant Deno tests and `deno check` for modified files.

## Documentation deliverable

Update the shared-hosting deployment documentation:

- operators configure block volume size/type, never a device path;
- the volume is ephemeral node cache after successful canonical object sync;
- an unconfirmed sync blocks drain/delete;
- explain expected Vultr Block Storage billing and cleanup behavior;
- include a staged test:

```text
capacity request -> volume create -> VM create -> volume attach ->
volume setup succeeds -> node enrolls -> drain -> stop/sync ->
VM delete -> volume detach/delete
```

Do not claim real-provider acceptance until that staged flow has executed
against Vultr.
