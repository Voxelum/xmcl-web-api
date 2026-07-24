# Handoff: Shared Node Control-Plane Transport

## Goal

Implement the durable, authenticated transport between the Cloudflare API
control plane and Go shared-node agents.

## Existing code

- Scheduler: `src/lib/sharedHostingScheduler.ts`
- User service API: `src/routes/sharedHostingServices.ts`
- Scheduler command interface: `SharedNodeCommandGateway`
- Scheduler persistence: `MongoSharedHostingSchedulerRepository`
- Go agent requirements: `docs/commercialization/shared-node-agent-handoff.md`

The scheduler currently creates these commands:

```text
workspace.restore_and_start
workspace.stop_and_sync
```

Each command includes `commandId`, `nodeId`, `serviceId`, `assignmentId`,
workspace revision metadata, and hard resource limits.

## Required delivery

1. Add a durable command outbox/queue keyed by `commandId`.
2. Implement authenticated node registration, heartbeat, long-poll command
   retrieval, command acknowledgement, `started`, and `stopped-and-synced`
   callbacks.
3. Adapt `SharedNodeCommandGateway.dispatch` to persist commands rather than
   directly calling an in-memory callback.
4. Adapt scheduler reports to call:
   - `SharedHostingScheduler.registerNode`
   - `SharedHostingScheduler.heartbeatNode`
   - `SharedHostingScheduler.reportStarted`
   - `SharedHostingScheduler.reportStoppedAndSynced`
5. Add a scheduled sweep for stale node heartbeats and unacknowledged commands.

## Versioned wire contract

The implemented Go/API contract is JSON `contractVersion: 1`. Every response
includes that field. Requests are signed over the exact raw body. Ack uses
numeric `leaseGeneration` and returns the acknowledged generation; lease renew
returns that same generation plus `leaseExpiresAt`. Heartbeats include agent
status/version and free/allocatable capacity. Object-storage credentials are
available only through the signed node credential URL, expire in at most fifteen
minutes, and carry the `shared-hosting/` object-operation scope. The control
plane reserves a collision-safe host port before dispatch and places it in
`command.connection.host` and `command.connection.hostPort`; agents must
reject an absent field rather than hash/select a port. `started` confirms the
same endpoint, and the control plane releases it only after accepted
stop/sync.

## Security requirements

- No public or unauthenticated node endpoints.
- Node identity must be mutually authenticated. Prefer mTLS plus a short-lived
  node credential issued at bootstrap.
- Every mutating request must use timestamp, nonce, body hash, signature, and
  replay protection.
- Verify that a node can only fetch or report commands assigned to its own
  `nodeId`.
- Command result callbacks must be idempotent on `commandId` and
  `assignmentId`.
- Do not return Vultr Object Storage credentials, object data, Docker details, or other node
  commands to users.

## Suggested API shape

These are internal routes, not public product routes:

```text
POST /v1/internal/shared-nodes/register
POST /v1/internal/shared-nodes/{nodeId}/heartbeat
POST /v1/internal/shared-nodes/{nodeId}/commands:next
POST /v1/internal/shared-nodes/{nodeId}/commands/{commandId}/ack
POST /v1/internal/shared-nodes/{nodeId}/assignments/{assignmentId}/started
POST /v1/internal/shared-nodes/{nodeId}/assignments/{assignmentId}/stopped-synced
```

Long-poll is preferred over an inbound port on compute nodes. Return at most one
command per request initially; the next command is not released until the prior
one is acknowledged or its lease expires.

## Correctness rules

- A command is delivered at least once; agent execution must be idempotent.
- A `started` callback is valid only for the currently assigned node and
  assignment ID.
- A `stopped-synced` callback is valid only for the same assignment and may
  advance, but never decrease, workspace revision.
- Failed command delivery must not release a scheduler slot.
- A node heartbeat timeout marks a node offline; it must not immediately delete
  unknown running services.

## Tests required

1. Node A cannot fetch or acknowledge Node B's command.
2. Replayed signed request is rejected.
3. Acknowledged command is not delivered again.
4. Expired command lease becomes redeliverable with the same command ID.
5. Stale/incorrect assignment result is rejected.
6. `stopped-synced` releases capacity and permits the FIFO queued service to
   start.
7. API transport tests use a fake node credential and never require Docker or
   Vultr Object Storage.
