# M5 Minecraft runtime publication proposal v1

This proposal documents the mounted internal worker API. It is a promotion
candidate only and does not modify `contracts/`.

It consumes `contracts/shared/v1` read-only:

- **D2**: M4 supplies the active lease binding, including the M3
  `authorizationId`; M5 does not authorize usage or read balances.
- **D3**: the raw worker usage payload is mapped to the referenced
  `canonical-usage-event.schema.json`. `sourceId` is the active `leaseId`;
  `sequence` is strictly increasing and usage intervals do not overlap.
- **D5**: after M3 returns `stop_required`, the worker stops Minecraft and M5
  emits the referenced `balance-exhaustion.schema.json` event. M4 owns the
  300-second force-stop escalation and lease closure.

`openapi.yaml` defines M5-owned request, response, token, heartbeat, runtime,
and operation payloads. It references rather than copies the shared canonical
usage and stopped-event schemas. Fixtures contain no credentials or provider
secrets and cover authentication, replay, ordering, settlement, and provider
failure behavior.

Promotion requires the shared contract owner to review this proposal and assign
it a published version. Production platform composition must inject the M4 lease
and M3 settlement adapters; otherwise the mounted routes return the explicit
`m5_runtime_unavailable` configuration error.
