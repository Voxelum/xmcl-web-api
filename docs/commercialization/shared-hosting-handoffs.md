# Shared Hosting Remaining Work Handoffs

The shared-hosting API control plane and Go node-agent specification already
exist. Do **not** assign every document to a separate agent: some documents
share an execution boundary. Delegate the three work packages below.

| Work package | Handoff documents | Parallelism / dependency |
| --- | --- | --- |
| **A. Node execution plane** | [Go node agent](shared-node-agent-handoff.md), [workspace object storage](handoffs/shared-workspace-storage.md) | Assign together to one agent. The agent must implement Vultr Object Storage revision manifests and Docker lifecycle in one idempotent execution path. |
| **B. Control-plane infrastructure** | [control-plane transport](handoffs/shared-control-plane-transport.md), [Vultr provisioning](handoffs/shared-vultr-node-provisioning.md) | One agent can own both, or two agents sequentially. Provisioning depends on finalized agent registration/bootstrap and transport credentials. |
| **C. Commercial product surfaces** | [billing and operations](handoffs/shared-billing-operations.md), [website product UI](handoffs/shared-product-ui.md) | Billing can proceed independently now. UI must wait for production payment, transport, agent, and commercial composition; it should not overlap with the API transport implementation. |

The API-side portion of C owns the durable ledger, PayPal provider boundary,
shared subscription/runtime billing, UTC renewal sweep, quota grace enforcement,
and admin reconciliation projection. The website UI remains an `xmcl-page`
deliverable and must consume the public projections only after the production
composition gate is opened.

All production work must preserve these boundaries:

- API control plane owns placement, subscription state, billing, and node lifecycle.
- The Go agent owns Docker, local NVMe, and Vultr Object Storage data transfer.
- Object storage is the canonical stopped-workspace source of truth.
- A running Minecraft container is never migrated.
- Commercial production routes remain disabled until their durable adapters and
  payment flow are complete.
