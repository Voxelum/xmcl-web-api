# Shared Hosting Delivery Status and Remaining Handoffs

## Completed implementation (2026-08-04)

The previously separate execution-plane and control-plane handoffs are now
implemented and reviewed together:

| Area                      | Delivered state                                                                                                                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node execution            | Go agent implements command-scoped Object Storage grants, layered workspace restore/sync, credential rotation, UID 1000 workspace ownership, retry/requeue, start/stop crash recovery, initial-world restore, and bounded transfer-grant renewal.   |
| Control plane             | Azure is the durable Cosmos-backed SGP control plane. It owns registration, signed transport, exact grants, ingress allocation, scheduler placement, Vultr Block Storage/Firewall lifecycle, drain/reconciliation, and hourly trusted billing work. |
| Runtime/compiler protocol | Generic Java 8/16/17/21/25 image, reviewed runtime catalog, local client-instance bundle validation, exact compiler grants, callback HMAC/replay protection, and immutable upload reconciliation are implemented.                                   |
| Billing staging           | Mongo ledger, Sandbox webhook verification, and narrow Worker → Azure M3 checkout ingress are implemented; public payment/shared-hosting routes remain disabled.                                                                                    |

## Remaining handoffs

| Work package                       | Required work                                                                                                                                                                           | Gate                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **A. Trusted compiler deployment** | Supply reviewed read-only JRE roots, approved loader/artifact catalog release, no-Docker/non-root sandbox adapter, workload identity, and server-owned Minecraft/EULA terms acceptance. | The compiler image deliberately returns unavailable until every adapter is injected. |
| **B. Real SGP acceptance**         | Run bundle → compiler → SGP node → external Minecraft connection → stop/sync → cross-node restore → drain/delete across reviewed Java/loader fixtures.                                  | Requires A; do not run installers on customer nodes.                                 |
| **C. M1/M3 staging acceptance**    | Configure browser OAuth staging session, then run real PayPal Sandbox order → approval → capture → verified single ledger credit, duplicate and recovery checks.                        | No production PayPal route until this passes.                                        |
| **D. Public commercial rollout**   | Complete M7 operator/refund/dispute workflows, production payment credentials/webhook, monitoring/alerts, reviewed pricing, and explicit product-route decision.                        | Must not be inferred from the staging proxies.                                       |

The API-side portion of C owns the durable ledger, PayPal provider boundary,
shared subscription/runtime billing, UTC renewal sweep, quota grace enforcement,
and admin reconciliation projection. The website UI remains an `xmcl-page`
deliverable and must consume the public projections only after the production
composition gate is opened.

All production work must preserve these boundaries:

- API control plane owns placement, subscription state, billing, and node
  lifecycle.
- The Go agent owns Docker, local NVMe, and Vultr Object Storage data transfer.
- Object storage is the canonical stopped-workspace source of truth.
- A running Minecraft container is never migrated.
- Commercial production routes remain disabled until their durable adapters and
  payment flow are complete.
