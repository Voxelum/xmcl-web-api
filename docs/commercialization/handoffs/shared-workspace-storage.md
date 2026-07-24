# Handoff: Shared Workspace Object Storage

## Goal

Provision and operate the canonical **Vultr Object Storage** workspace storage used by
shared Minecraft services.

## Existing contract

Each scheduler service contains:

```text
objectPrefix: shared-hosting/<accountId>/<serviceId>/
revision: integer
sizeBytes: integer
sha256: optional manifest hash
syncedAt: optional ISO time
```

Relevant code:

- `src/lib/sharedHostingScheduler.ts`
- `docs/commercialization/shared-node-agent-handoff.md`
- Existing backup object-store boundary:
  `src/lib/worldBackupObjectStorage.ts`

The agent restores a stopped service from object storage before Docker start and
uploads a new immutable revision after Docker stop.

## Required delivery

1. Create a private Vultr Object Storage bucket for shared workspaces.
2. Define Vultr Object Storage policy and agent credential rotation strategy.
3. Implement revision layout:

   ```text
   shared-hosting/<accountId>/<serviceId>/
     revisions/<revision>/files/...
     revisions/<revision>/manifest.json
   ```

4. Upload files first and publish the revision manifest last.
5. On restore, use only a complete manifest; verify paths, sizes, and SHA-256
   before workspace use.
6. Support multipart upload, resumable retries, and interrupted-upload cleanup.
7. Define retention/lifecycle rules:
   - retain canonical current revision;
   - retain approved historical revisions/backup policy;
   - safely remove unreferenced incomplete revisions;
   - never delete a revision currently referenced by a service.
8. Produce storage metrics for logical bytes, actual object bytes, restore
   download bytes, sync upload bytes, and failures.

## Security requirements

- Bucket private, no public website/static access.
- Scope agent credentials to required shared-hosting object operations only.
- Validate every object path; reject absolute paths, traversal, symlinks that
  escape the workspace, device files, and unsafe archive entries.
- Do not log signed URLs, Vultr Object Storage keys, secret keys, world data, or server secrets.
- Encrypt in transit; enable provider encryption at rest where available.

## Billing handoff

The shared-hosting base fee includes persistent data quota:

| Plan | Persistent quota |
| --- | ---: |
| Small | 32GiB |
| Medium | 48GiB |
| Large | 64GiB |

Expose measured canonical workspace bytes to the billing/operations owner. Do
not independently charge or delete user data before the billing policy defines
overage and grace periods.

## Tests required

1. Partial revision without manifest is never restored.
2. Manifest hash mismatch blocks restore.
3. Path traversal and unsafe symlink/archive entries are rejected.
4. A failed upload leaves the prior complete revision restorable.
5. Repeated sync of one command/revision is idempotent.
6. Retention never deletes the current manifest/revision.
