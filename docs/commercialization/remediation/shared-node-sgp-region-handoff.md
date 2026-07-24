# Shared-node Singapore region migration handoff

## Context and decision

The authenticated Vultr account’s current API region list contains no Taipei
(`tpe`) Compute region and no Taipei Object Storage cluster. The approved
shared-hosting staging and production pool region is **Singapore (`sgp`)**.
Singapore supports both high-performance Block Storage and Vultr Object
Storage clusters (`sgp1` / `sgp2`).

The shared-node implementation currently conflates a hardcoded logical
`"taipei"` label with the provider region ID and rejects all other registration
values. This must be removed before any real staging resource is created.

## Scope

Own this narrow cross-repository package:

```text
C:\Users\ci010-4090\Workspace\xmcl-web-api
C:\Users\ci010-4090\Workspace\xmcl-shared-node-agent
```

Modify only shared-hosting/shared-node config, runtime, transport, provisioner,
agent config/control-plane registration, tests, and directly related
documentation/handoffs.

Do **not** change legacy dedicated-server contracts, `serverControl`,
`serverRepository`, existing dedicated server region fixtures, billing,
workspace blob grants, Firewall/Block Storage lifecycle semantics, public
routes, or website UI.

Other worktrees are dirty. Preserve existing changes and avoid broad
search/replace of every historic `"taipei"` reference.

## Required configuration contract

Replace the shared-node-only environment setting:

```text
VULTR_TAIPEI_REGION_ID
```

with:

```text
VULTR_SHARED_NODE_REGION_ID=sgp
```

Requirements:

1. No shared-node production composition path may read
   `VULTR_TAIPEI_REGION_ID`.
2. `VULTR_SHARED_NODE_REGION_ID` must be required and validated as a strict
   provider region identifier; production configuration fails closed if absent
   or malformed.
3. The current default/recommended deployment documentation must name `sgp`,
   `sgp1.vultrobjects.com` or another operator-selected Singapore cluster, and
   `sgp` Object Storage region. Do not silently use `ewr` or Taipei defaults.
4. `VULTR_SHARED_NODE_BLOCK_STORAGE_*`, Firewall Group configuration,
   scheduler placement, VM creation, volume creation, tags, agent environment,
   and registration must all refer to the same configured shared-node region.

## API control-plane model

The scheduler’s shared-node region field and capacity request region must be
generic validated strings, not the literal `"taipei"`. This product still uses
one configured shared pool region at a time.

Add a required shared pool region to the scheduler/runtime configuration:

- a shared node registration only succeeds if its declared region exactly
  equals the configured pool region;
- all nodes that scheduler may select use the configured pool region;
- capacity requests use that same region;
- stale/reconciled records with a different region fail closed;
- do not permit a caller to select a region from a browser request.

Retain a local-demo-safe explicit local region value in the local demo
composition; it must not need real Vultr variables.

The generic `VultrV2Adapter` option currently named `taipeiRegionId` should be
renamed to a region-neutral name such as `regionId`; error messages and tests
must use the new shared-node variable name. Instance and Block Storage
provisioning use that exact provider ID. Shared-node tags should likewise
contain the configured region, not `xmcl-region:taipei`.

## Go node agent

Add required configuration:

```text
XMCL_SHARED_NODE_REGION=sgp
```

Cloud-init supplies it from `VULTR_SHARED_NODE_REGION_ID`. The Go client must
send that value as `region` during bootstrap registration. It must validate it
as a bounded safe provider-region identifier and never hardcode `"taipei"`.

Do not use public metadata or a guessed provider region for this identity; the
control plane config and cloud-init are the source of truth.

## Tests

Add/update targeted tests proving:

1. Complete shared-node production composition accepts `sgp` and mounts only
   when every shared-node setting, including the generic region, is valid.
2. A node registration for `sgp` succeeds only against an `sgp` configured
   runtime; `taipei`, a different provider region, malformed values, and
   mismatched durable records fail before scheduling/dispatch.
3. Vultr VM and Block Storage create payloads use `sgp`; no shared-node test
   assumes `tpe`.
4. Cloud-init carries `XMCL_SHARED_NODE_REGION='sgp'`.
5. Go agent config rejects a missing/invalid region and the exact bootstrap
   request sends `region:"sgp"`.
6. Existing dedicated-server tests/contracts remain unchanged and compile.

Run focused Deno tests/check and `gofmt`, `go test ./...`, and `go vet ./...`.

## Documentation

Update only current shared-node deployment/handoff docs. Record:

- Singapore is the active shared pool location because Taipei is unavailable
  to the current Vultr account;
- a future multi-region product needs explicit region selection and
  cross-region data policy—it is out of scope;
- exact staging values:

```text
VULTR_SHARED_NODE_REGION_ID=sgp
XMCL_VULTR_OBJECT_STORAGE_ENDPOINT=https://sgp1.vultrobjects.com
XMCL_VULTR_OBJECT_STORAGE_REGION=sgp
XMCL_SHARED_NODE_REGION=sgp  # cloud-init owned; operators do not set it manually
```

Do not claim production readiness until real Singapore staging completes.
