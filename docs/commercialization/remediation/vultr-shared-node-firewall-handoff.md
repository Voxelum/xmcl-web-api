# Vultr shared-node Firewall Group handoff

## Scope

Implement only the shared-node Firewall Group configuration, VM attachment, and
fail-closed validation in:

```text
C:\Users\ci010-4090\Workspace\xmcl-web-api
```

Do not modify the Go node agent, workspace blob/pre-signed URL broker, billing,
scheduler placement policy, Block Storage lifecycle, public user routes, or
website UI.

This package may touch:

- `src/config.ts`
- `src/lib/vultr.ts` and its tests
- `src/lib/sharedHostingRuntime.ts`
- `src/lib/sharedNodeProvisioner.ts` and its tests
- production composition tests and directly related deployment documentation

Preserve all existing dirty changes from other completed work packages.

## Objective

A shared compute VM must be born inside a dedicated Vultr Firewall Group. The
only public inbound service is Minecraft TCP within the exact control-plane
allocated port range. No VM must have a window where it is created without the
Firewall Group and attached later.

This is defense in depth for the current `connection.hostPort` reservation:
the scheduler controls which port receives a container; the Firewall Group
ensures that accidental host services or agent mistakes on every other port
remain unreachable from the Internet.

## Operator-owned Firewall Group

The group is **not** created or deleted by per-node provisioning. It is a
long-lived, pre-created Vultr Firewall Group dedicated exclusively to the
shared-node pool. The operator owns its ID, rule changes, and lifecycle.

Add required production configuration:

```text
VULTR_SHARED_NODE_FIREWALL_GROUP_ID
XMCL_SHARED_NODE_INGRESS_PORT_MIN
XMCL_SHARED_NODE_INGRESS_PORT_MAX
```

Requirements:

1. `VULTR_SHARED_NODE_FIREWALL_GROUP_ID` is a non-empty provider ID with a
   conservative identifier format; it must never be accepted from a browser
   request.
2. Port min/max must be explicit safe integers from `1024` to `65535` and
   `min <= max`. Do not silently use a different runtime default when the
   firewall group is configured.
3. The dedicated group must contain only this inbound policy:

   ```text
   IPv4 TCP <min>:<max> from 0.0.0.0/0
   ```

   It must not allow SSH `22`, agent metrics `9464`, Docker `2375/2376`, RCON,
   control-plane internals, storage, or catch-all inbound rules.
4. IPv6 must stay disabled/unassigned for these node VMs unless the operator
   explicitly creates an equivalent IPv6 policy and the implementation has a
   reviewed IPv6 ingress model. Do not quietly expose IPv6.
5. Agent-to-Worker and agent-to-Vultr Object Storage are outbound HTTPS
   connections; they require no inbound firewall exception.

Document the exact group setup and that the range needs enough ports for the
maximum planned services per node.

## Provider and instance contract

Extend the existing optional `CreateVultrInstance` input with:

```ts
firewallGroupId?: string
```

The generic adapter must include `firewall_group_id` in the initial
`POST /v2/instances` payload when provided. This is the only permitted
attachment path for a new shared node.

Parse the provider’s instance firewall group identity where supplied and expose
an optional `firewallGroupId` on `VultrInstance`. Reconciled/read instances
must be verified to have the expected group before the provisioner can attach
Block Storage, wait for registration, or mark a node ready.

Do not widen unrelated dedicated-server interfaces with a mandatory firewall
method. An optional create field and optional response field must remain
compatible with existing dedicated-server fakes.

Pass the configured group ID through `SharedNodeProvisioningConfig` and from
`createSharedHostingRuntime` into `VultrSharedNodeProvisioner`. Persist the
configured expected group ID in `SharedNodeProvisioningRecord`; a retry must
refuse a record whose expected group differs from configuration.

If a create/reconcile provider response does not prove the expected group is
attached, mark the request unknown or definitive failure according to existing
provider semantics and **do not** issue node enrollment or schedule workloads.
Never try to “repair” a wrong group by attaching a firewall after VM creation:
that reintroduces the unprotected-VM window and risks modifying a wrong VM.

## Production gates

`hasSharedNodeSettings` / production internal transport mounting must require:

- a valid Firewall Group ID;
- valid explicit ingress port min/max;
- the previously required Block Storage, signing, agent artifact, Vultr, and
  billing settings.

Local demo remains isolated and must not require any Vultr firewall setting.
Public shared-hosting routes remain disabled.

## Required tests

Add focused tests that prove:

1. A shared-node VM create request carries exactly the configured
   `firewall_group_id`, before any agent registration can occur.
2. An instance returned/reconciled with missing or different firewall group
   cannot become ready and does not dispatch a command.
3. Missing/malformed group ID or invalid/missing ingress range leaves
   production internal transport unmounted.
4. Changing firewall config on a pre-existing provisioning record fails
   closed, without replacing the VM or altering provider firewall state.
5. Existing dedicated server `VultrAdapter` fakes/types continue compiling.
6. No cloud-init, browser route, public API response, or node command includes
   the Firewall Group ID.

Run the narrow relevant Deno tests and `deno check` for modified files.

## Deployment documentation

Document:

- how to pre-create the dedicated group in Vultr;
- required inbound IPv4 TCP rule and the forbidden rules;
- required Worker settings;
- the relationship between control-plane port range and firewall range;
- staged verification:

```text
inspect VM firewall_group_id -> confirm only allowed port range is reachable
-> verify metrics/SSH/Docker/RCON are unreachable -> start one service on a
reserved port -> connect to it -> stop and verify the port no longer accepts a
Minecraft connection
```

Do not claim production readiness until this runs against an actual Vultr VM.
