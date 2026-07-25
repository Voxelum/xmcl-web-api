# Shared hosting explicit local world migration handoff

## Product goal

After a user deploys an already-working local modded **client instance** to a
shared service, they may explicitly choose a local world/save to seed that
service. This is separate from the instance bundle because worlds can be large,
private, and mutable.

```text
local instance deployment -> compiler content selected
                              |
optional local save migration |
                              v
shared service initial world revision -> start
```

Never silently include `saves/` in the local-instance bundle.

## Scope

Work in:

```text
C:\Users\ci010-4090\Workspace\x-minecraft-launcher
C:\Users\ci010-4090\Workspace\xmcl-web-api
C:\Users\ci010-4090\Workspace\xmcl-shared-minecraft-compiler
```

Preserve unrelated dirty launcher work. Do not modify billing, Firewall,
Vultr, runtime Java catalog, or arbitrary dedicated-server export behavior.

## User experience

After a shared modded deployment is published but before the service first
starts, show:

```text
Optional: migrate a local world
```

The user selects exactly one world from the current local instance. Show its
name, logical size, and explicit warning:

```text
This uploads a copy of this local world to your shared server.
Your local save is not deleted or continuously synchronized.
```

The action must be unavailable for a `starting`, `running`, or `stopping`
service. To replace a world later, the user stops the service first and
performs an explicit migration/restore operation.

## Archive format

Define `.xmcl-world-seed`:

```text
world.json
world/
  level.dat
  region/
  ...
```

`world.json` contains:

```json
{
  "schemaVersion": 1,
  "worldName": "My World",
  "source": "local_instance",
  "files": [
    { "path": "world/level.dat", "sha256": "...", "sizeBytes": 1 }
  ]
}
```

Requirements:

- archive is deterministic, streaming, bounded in compressed/logical size,
  count, and path length;
- reject symlinks, junctions, absolute/traversal paths, special files,
  generated scripts, auth/credentials, and client-only artifacts;
- preserve only world data under `world/`; dimensions are within it;
- hash each file and the final archive;
- local world directory remains untouched;
- UI supports progress/cancel/retry and never logs/persists signed URLs.

## Web API

Add authenticated, service-owned routes:

```text
POST /v1/shared-hosting/services/:serviceId/world-seeds
POST /v1/shared-hosting/world-seeds/:seedId/upload-url
POST /v1/shared-hosting/world-seeds/:seedId/complete
GET  /v1/shared-hosting/services/:serviceId/world-seeds
```

Rules:

1. Require `account:write`, service ownership, active subscription, and
   idempotency keys for mutations.
2. Only allow a world seed while the service is not assigned/running.
3. Issue one short-lived exact upload URL, bound to account/service/seed/hash/
   expected size. No broad storage credentials/List/Delete.
4. Verify archive/hash/schema server-side after completion.
5. A successful seed creates a service-owned immutable initial world content
   pointer/revision. It must be selected before a later `start`.
6. A failed seed leaves the existing selected world/content unchanged.
7. Existing runtime stop/sync revisions remain authoritative after a service
   has run. A seed cannot overwrite a completed runtime revision.

Compiler/content worker may unpack the seed only through a compiler-specific
exact grant. The node agent must restore it only when the control plane includes
the selected initial world in a start command; do not turn the node into a
general world import endpoint.

## Launcher integration

Use existing local save discovery APIs. Add a narrow world-seed exporter and
main-process upload service; do not reuse arbitrary server SSH/export flows.

The launcher must:

- list eligible worlds for the selected instance;
- create deterministic archive and review metadata;
- upload via the main process;
- poll/show seed status;
- make no claim that local and remote worlds are synchronized after import.

## Tests

Launcher:

1. Deterministic seed archive from a local world.
2. Excludes/rejects symlink, traversal, special file, script, and private data.
3. Does not modify local world.
4. Cancel/retry does not expose signed URL.

API/compiler:

1. Cross-account/service seed and running-service seed fail.
2. Hash/schema mismatch cannot select a seed.
3. Seed becomes initial world only before first start.
4. A runtime sync revision cannot be overwritten by a seed.
5. Failed seed preserves prior state.

Run focused launcher/API/compiler tests and type checks.
