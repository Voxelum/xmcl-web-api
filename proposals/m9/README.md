# M9 Modpack Deployment proposal

Version `0.1.0` is a module-local promotion candidate. It consumes
`contracts/shared/v1` unchanged: M1 session scopes authenticate user commands;
M4 is the account/server/template authority; M5 stages, verifies, switches, and
restores snapshots. M9 does not write storage accounting, balances, usage, or
administrator-operation state.

The proposal owns ZIP validation reports, immutable manifests, asynchronous
deployment tasks, and M9 worker-event de-duplication. `deployment.worker.v1`
uses `deploymentId` as its ordered source: a duplicate `eventId` is ignored,
lower sequence is rejected, and the same sequence with different content is a
conflict. A D5 `runtime.stopped.v1` target rejects apply before queueing.

Promotion checklist: shared owner reviews the OpenAPI, three schemas, event
schema, and fixtures. Fields may only be added as optional fields after v1.
