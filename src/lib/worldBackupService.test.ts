import assert from "node:assert/strict";
import { createApp } from "../app.ts";
import { AccountMergeService } from "./accountMerge.ts";
import { AccountService, MemoryAccountRepository } from "./account.ts";
import type { AccountRuntime } from "./accountRuntime.ts";
import { SessionService } from "./session.ts";
import type {
  WorldBackupResource,
  WorldBackupStorageBillingCursor,
  WorldBackupStorageUsageEvent,
  WorldBackupUploadGrant,
} from "./worldBackupContracts.ts";
import type {
  WorldBackupObjectMetadata,
  WorldBackupObjectStorage,
} from "./worldBackupObjectStorage.ts";
import {
  WORLD_BACKUP_RESTORE_WORKER_SCOPE,
  type WorldBackupCreateCommand,
  WorldBackupError,
  WorldBackupService,
  type WorldBackupStore,
} from "./worldBackupService.ts";

const restoreWorker = {
  workerId: "worker_001",
  serverId: "server_001",
  leaseId: "lease_001",
  scopes: [WORLD_BACKUP_RESTORE_WORKER_SCOPE],
} as const;

class MemoryStore implements WorldBackupStore {
  readonly backups = new Map<string, WorldBackupResource>();
  readonly createKeys = new Map<string, string>();
  readonly cursors = new Map<string, WorldBackupStorageBillingCursor>();
  readonly events = new Map<string, { sequence: number; eventId: string }>();
  readonly storageUsageOutbox = new Map<string, WorldBackupStorageUsageEvent>();

  async createBackup(backup: WorldBackupResource) {
    if (this.backups.has(backup.backupId)) return "conflict" as const;
    this.backups.set(backup.backupId, structuredClone(backup));
    this.createKeys.set(
      `${backup.accountId}:${backup.createIdempotencyKey}`,
      backup.backupId,
    );
    return "created" as const;
  }
  async getBackup(backupId: string) {
    const backup = this.backups.get(backupId);
    return backup && structuredClone(backup);
  }
  async findBackupByCreateKey(accountId: string, idempotencyKey: string) {
    const id = this.createKeys.get(`${accountId}:${idempotencyKey}`);
    return id ? await this.getBackup(id) : undefined;
  }
  async listSource(
    accountId: string,
    sourceType: WorldBackupResource["sourceType"],
    sourceId: string,
  ) {
    return [...this.backups.values()].filter((backup) =>
      backup.accountId === accountId && backup.sourceType === sourceType &&
      backup.sourceId === sourceId
    ).map((backup) => structuredClone(backup));
  }
  async listBillable(accountId: string) {
    return [...this.backups.values()].filter((backup) =>
      backup.accountId === accountId && backup.verified &&
      backup.status !== "deleted"
    ).map((backup) => structuredClone(backup));
  }
  async saveBackup(backup: WorldBackupResource) {
    this.backups.set(backup.backupId, structuredClone(backup));
  }
  async incrementParentReference(backupId: string) {
    const parent = this.backups.get(backupId);
    if (!parent) return "missing" as const;
    if (parent.status === "deleted") return "deleted" as const;
    parent.referenceCount += 1;
    return "updated" as const;
  }
  async decrementParentReference(backupId: string) {
    const parent = this.backups.get(backupId);
    if (parent) parent.referenceCount -= 1;
  }
  async getBillingCursor(accountId: string) {
    const value = this.cursors.get(accountId);
    return value && structuredClone(value);
  }
  async saveBillingCursor(cursor: WorldBackupStorageBillingCursor) {
    this.cursors.set(cursor.accountId, structuredClone(cursor));
  }
  async commitStorageUsage(
    input: {
      event: WorldBackupStorageUsageEvent;
      cursor: WorldBackupStorageBillingCursor;
    },
  ) {
    const existing = this.storageUsageOutbox.get(input.event.eventId);
    if (existing) {
      return JSON.stringify(existing) === JSON.stringify(input.event)
        ? "duplicate" as const
        : "conflict" as const;
    }
    this.storageUsageOutbox.set(
      input.event.eventId,
      structuredClone(input.event),
    );
    this.cursors.set(input.cursor.accountId, structuredClone(input.cursor));
    return "committed" as const;
  }
  async recordRestoreEvent(
    input: { backupId: string; eventId: string; sequence: number },
  ) {
    if (!this.backups.has(input.backupId)) return "conflict" as const;
    const current = this.events.get(input.backupId);
    if (current?.eventId === input.eventId) return "duplicate" as const;
    if (current && input.sequence <= current.sequence) {
      return "out_of_order" as const;
    }
    this.events.set(input.backupId, {
      sequence: input.sequence,
      eventId: input.eventId,
    });
    return "accepted" as const;
  }
}

class MemoryObjects implements WorldBackupObjectStorage {
  readonly objects = new Map<string, WorldBackupObjectMetadata>();
  grants: WorldBackupUploadGrant[] = [];
  async issueSingleUseUpload(
    input: WorldBackupObjectMetadata & { expiresAt: string },
  ) {
    const grant = {
      backupId: input.backupId,
      url: `https://object.invalid/${input.objectKey}`,
      expiresAt: input.expiresAt,
      contentLength: input.contentLength,
      sha256: input.sha256,
      requiredHeaders: {
        "content-length": String(input.contentLength),
        "content-type": input.contentType,
        "x-amz-meta-backup-id": input.backupId,
        "x-amz-meta-sha256": input.sha256,
        "x-amz-meta-format-version": String(input.formatVersion),
      },
    };
    this.grants.push(grant);
    return grant;
  }
  async head(key: string) {
    const value = this.objects.get(key);
    return value && structuredClone(value);
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

function fixture(
  options: {
    allowed?: boolean;
    authorization?: "authorized" | "rejected" | "unavailable";
  } = {},
) {
  const store = new MemoryStore();
  const objects = new MemoryObjects();
  let clock = "2026-07-22T10:00:00.000Z";
  let sequence = 0;
  const usage: WorldBackupStorageUsageEvent[] = [];
  const reserves: unknown[] = [];
  const service = new WorldBackupService(
    store,
    {
      verify: async () => ({
        allowed: options.allowed ?? true,
        reason: "not_owner",
      }),
    },
    objects,
    {
      getPolicy: async () => ({
        freeBytes: 1_073_741_824 as const,
        policyVersion: 1 as const,
      }),
    },
    {
      authorize: async (input) => {
        reserves.push(input);
        if (options.authorization === "rejected") {
          return {
            status: "rejected" as const,
            reason: "insufficient_balance" as const,
          };
        }
        if (options.authorization === "unavailable") {
          return {
            status: "rejected" as const,
            reason: "unavailable" as const,
          };
        }
        return {
          status: "authorized" as const,
          authorizationId: "auth_001",
          rateVersion: input.rateVersion,
          expiresAt: input.expiresAt,
        };
      },
    },
    {
      settle: async (event) => {
        usage.push(event);
        return {
          settlementId: `settlement_${event.eventId}`,
          usageEventId: event.eventId,
          action: "continue" as const,
          status: "settled" as const,
          rateVersion: event.rateVersion,
        };
      },
    },
    () => clock,
    (prefix) => `${prefix}_${++sequence}`,
  );
  return {
    service,
    store,
    objects,
    usage,
    reserves,
    setClock(value: string) {
      clock = value;
    },
  };
}

function command(
  overrides: Partial<WorldBackupCreateCommand> = {},
): WorldBackupCreateCommand {
  return {
    accountId: "account_001",
    sourceType: "client_world",
    sourceId: "world-source_001",
    worldId: "world_001",
    format: "linear",
    formatVersion: 1,
    contentLength: 1024,
    sha256: "a".repeat(64),
    contentType: "application/vnd.xmcl.linear",
    compression: "xmcl_linear",
    explicitManual: true,
    idempotencyKey: "create_001",
    requestId: "request_001",
    ...overrides,
  };
}

async function ready(f: ReturnType<typeof fixture>, input = command()) {
  const created = await f.service.create(input);
  const issued = await f.service.issueUpload(
    input.accountId,
    created.backup.backupId,
    "upload_request",
  );
  f.objects.objects.set(
    `world-backups/${input.accountId}/${created.backup.backupId}.linear`,
    {
      objectKey:
        `world-backups/${input.accountId}/${created.backup.backupId}.linear`,
      contentLength: created.backup.sizeBytes,
      sha256: created.backup.sha256,
      contentType: created.backup.contentType,
      backupId: created.backup.backupId,
      format: created.backup.format,
      formatVersion: created.backup.formatVersion,
      formatVerified: true,
    },
  );
  await f.service.complete(
    input.accountId,
    created.backup.backupId,
    "complete_request",
  );
  return { ...created, issued };
}

Deno.test("accepts only explicit compressed Linear objects owned by the account", async () => {
  const f = fixture();
  for (
    const invalid of [
      command({ explicitManual: false as true }),
      command({ compression: "zip" as "xmcl_linear" }),
      command({
        contentType: "application/zip" as "application/vnd.xmcl.linear",
      }),
      command({ format: "layered_linear" }),
      command({ sha256: "not-a-hash" }),
    ]
  ) {
    await assert.rejects(
      () => f.service.create(invalid),
      (error) =>
        error instanceof WorldBackupError && error.code === "invalid_backup",
    );
  }
  const denied = fixture({ allowed: false });
  await assert.rejects(
    () => denied.service.create(command()),
    (error) =>
      error instanceof WorldBackupError && error.code === "source_forbidden",
  );
});

Deno.test("creates idempotently and binds single-use grants to backup, length, hash, headers, and expiry", async () => {
  const f = fixture();
  const first = await f.service.create(command());
  const retry = await f.service.create(command());
  assert.equal(retry.backup.backupId, first.backup.backupId);
  assert.equal(retry.task.taskId, first.task.taskId);
  assert.ok(first.task.taskId);
  const result = await f.service.issueUpload(
    "account_001",
    first.backup.backupId,
    "upload_request",
  );
  assert.deepEqual(result.grant, {
    backupId: first.backup.backupId,
    url:
      `https://object.invalid/world-backups/account_001/${first.backup.backupId}.linear`,
    expiresAt: "2026-07-22T10:15:00.000Z",
    contentLength: 1024,
    sha256: "a".repeat(64),
    requiredHeaders: {
      "content-length": "1024",
      "content-type": "application/vnd.xmcl.linear",
      "x-amz-meta-backup-id": first.backup.backupId,
      "x-amz-meta-sha256": "a".repeat(64),
      "x-amz-meta-format-version": "1",
    },
  });
  const uploadRetry = await f.service.issueUpload(
    "account_001",
    first.backup.backupId,
    "upload_request",
  );
  assert.deepEqual(uploadRetry.grant, result.grant);
  assert.equal(f.reserves.length, 0, "free storage never calls Billing");
});

Deno.test("does not complete hash or length mismatches, upload timeouts, or invalid status retries", async () => {
  const f = fixture();
  const created = await f.service.create(command());
  await f.service.issueUpload(
    "account_001",
    created.backup.backupId,
    "upload_request",
  );
  f.objects.objects.set(
    `world-backups/account_001/${created.backup.backupId}.linear`,
    {
      objectKey: `world-backups/account_001/${created.backup.backupId}.linear`,
      backupId: created.backup.backupId,
      contentLength: 1_023,
      sha256: "b".repeat(64),
      contentType: "application/vnd.xmcl.linear",
      format: "linear",
      formatVersion: 1,
      formatVerified: false,
    },
  );
  await assert.rejects(
    () =>
      f.service.complete(
        "account_001",
        created.backup.backupId,
        "complete_request",
      ),
    (error) =>
      error instanceof WorldBackupError &&
      error.code === "upload_verification_failed",
  );
  f.setClock("2026-07-22T10:15:00.001Z");
  await assert.rejects(
    () =>
      f.service.complete(
        "account_001",
        created.backup.backupId,
        "complete_request",
      ),
    (error) =>
      error instanceof WorldBackupError && error.code === "upload_expired",
  );
  await assert.rejects(
    () =>
      f.service.restore(
        "account_001",
        created.backup.backupId,
        "restore_request",
      ),
    (error) => error instanceof WorldBackupError && error.code === "conflict",
  );
});

Deno.test("uses a persistent parent reference count and drives restore events through a safe lifecycle", async () => {
  const f = fixture();
  const parent = await ready(
    f,
    command({
      sourceType: "hosted_server_world",
      sourceId: restoreWorker.serverId,
    }),
  );
  const child = await f.service.create(command({
    sourceType: "hosted_server_world",
    sourceId: restoreWorker.serverId,
    format: "layered_linear",
    parentBackupId: parent.backup.backupId,
    idempotencyKey: "create_child",
  }));
  assert.equal(
    (await f.service.get("account_001", parent.backup.backupId)).referenceCount,
    1,
  );
  await assert.rejects(
    () =>
      f.service.delete("account_001", parent.backup.backupId, "delete_parent"),
    (error) =>
      error instanceof WorldBackupError && error.code === "parent_in_use",
  );
  await f.service.delete("account_001", child.backup.backupId, "delete_child");
  assert.equal(
    (await f.service.get("account_001", parent.backup.backupId)).referenceCount,
    0,
  );

  await f.service.restore("account_001", parent.backup.backupId, "restore_001");
  assert.deepEqual(
    await f.service.handleRestoreEvent(parent.backup.backupId, {
      eventId: "restore_001",
      sequence: 1,
      type: "restore_started",
      occurredAt: "2026-07-22T10:00:01.000Z",
    }, restoreWorker),
    { duplicate: false },
  );
  assert.deepEqual(
    await f.service.handleRestoreEvent(parent.backup.backupId, {
      eventId: "restore_001",
      sequence: 1,
      type: "restore_started",
      occurredAt: "2026-07-22T10:00:01.000Z",
    }, restoreWorker),
    { duplicate: true },
  );
  await assert.rejects(
    () =>
      f.service.handleRestoreEvent(parent.backup.backupId, {
        eventId: "restore_stale",
        sequence: 1,
        type: "restore_succeeded",
        occurredAt: "2026-07-22T10:00:02.000Z",
      }, restoreWorker),
    (error) =>
      error instanceof WorldBackupError && error.code === "out_of_order",
  );
  await f.service.handleRestoreEvent(parent.backup.backupId, {
    eventId: "restore_002",
    sequence: 2,
    type: "restore_succeeded",
    occurredAt: "2026-07-22T10:00:02.000Z",
  }, restoreWorker);
  assert.equal(
    (await f.service.get("account_001", parent.backup.backupId)).status,
    "ready",
  );
});

Deno.test("rejects a layer reference that would attribute another account's physical object", async () => {
  const f = fixture();
  const parent = await ready(f);
  await assert.rejects(
    () =>
      f.service.create(command({
        accountId: "account_002",
        format: "layered_linear",
        parentBackupId: parent.backup.backupId,
        idempotencyKey: "cross_account_layer",
      })),
    (error) =>
      error instanceof WorldBackupError && error.code === "invalid_backup",
  );
});

Deno.test("settles prior overage before reference or deletion changes and counts each physical layer once", async () => {
  const f = fixture();
  const parent = await ready(
    f,
    command({
      contentLength: 1_073_741_924,
      idempotencyKey: "overage_parent",
      sha256: "b".repeat(64),
    }),
  );
  f.setClock("2026-07-22T10:00:10.000Z");
  await f.service.create(command({
    format: "layered_linear",
    parentBackupId: parent.backup.backupId,
    idempotencyKey: "overage_child",
    sha256: "c".repeat(64),
  }));
  await f.service.create(command({
    format: "layered_linear",
    parentBackupId: parent.backup.backupId,
    idempotencyKey: "overage_child_second_reference",
    sha256: "d".repeat(64),
  }));
  assert.deepEqual(await f.service.storageUsage("account_001"), {
    accountId: "account_001",
    policy: { freeBytes: 1_073_741_824, policyVersion: 1 },
    usedBytes: 1_073_741_924,
    overageBytes: 100,
    lastSettledAt: "2026-07-22T10:00:10.000Z",
    settlementIntervalSeconds: 3600,
    countedObjects: [{
      objectId: parent.backup.objectId,
      storageOwnerAccountId: "account_001",
      physicalBytes: 1_073_741_924,
      activeReferenceCount: 3,
      verified: true,
    }],
  });
  assert.deepEqual(f.usage.map((event) => event.quantity), [1_000]);
  assert.equal(
    f.store.storageUsageOutbox.size,
    1,
    "the cursor and canonical event share a durable transaction",
  );
  assert.deepEqual(f.usage[0], {
    eventType: "usage.recorded.v1",
    eventId:
      "storage-retention:account_001:2026-07-22T10:00:00.000Z:2026-07-22T10:00:10.000Z",
    schemaVersion: 1,
    accountId: "account_001",
    authorizationId: "auth_001",
    resource: "storage_retention",
    sourceId: "storage:account_001",
    quantity: 1_000,
    unit: "byte_second",
    rateVersion: 1,
    sequence: 1,
    intervalStart: "2026-07-22T10:00:00.000Z",
    intervalEnd: "2026-07-22T10:00:10.000Z",
    occurredAt: "2026-07-22T10:00:10.000Z",
    idempotencyKey:
      "storage-retention:account_001:2026-07-22T10:00:00.000Z:2026-07-22T10:00:10.000Z",
  });
  f.setClock("2026-07-22T10:00:20.000Z");
  await f.service.delete("account_001", parent.backup.backupId, "not_reached")
    .catch(() => {});
  assert.deepEqual(
    f.usage.map((event) => event.quantity),
    [1_000],
    "blocked deletion does not mutate or double-bill",
  );
});

Deno.test("refuses an overage upload when Billing reports insufficient balance", async () => {
  const f = fixture({ authorization: "rejected" });
  const created = await f.service.create(command({
    contentLength: 1_073_741_825,
    sha256: "d".repeat(64),
  }));
  await assert.rejects(
    () =>
      f.service.issueUpload("account_001", created.backup.backupId, "upload"),
    (error) =>
      error instanceof WorldBackupError &&
      error.code === "insufficient_balance",
  );
  assert.equal(
    (await f.service.get("account_001", created.backup.backupId)).status,
    "creating",
  );
});

Deno.test("reports an Billing provider outage without transitioning the backup", async () => {
  const f = fixture({ authorization: "unavailable" });
  const created = await f.service.create(
    command({ contentLength: 1_073_741_825, sha256: "e".repeat(64) }),
  );
  await assert.rejects(
    () =>
      f.service.issueUpload("account_001", created.backup.backupId, "upload"),
    (error) =>
      error instanceof WorldBackupError &&
      error.code === "authorization_unavailable",
  );
  assert.equal(
    (await f.service.get("account_001", created.backup.backupId)).status,
    "creating",
  );
});

Deno.test("mounts WorldBackup through Account sessions and a dedicated restore-worker authenticator", async () => {
  const f = fixture();
  const repository = new MemoryAccountRepository();
  await repository.saveAccount({
    accountId: "account_001",
    status: "active",
    createdAt: "2026-07-22T10:00:00.000Z",
    identities: [],
  });
  await repository.saveAccount({
    accountId: "account_002",
    status: "active",
    createdAt: "2026-07-22T10:00:00.000Z",
    identities: [],
  });
  const sessions = new SessionService(
    repository,
    "fixture-only-session-secret-at-least-32-bytes",
  );
  const runtime: AccountRuntime = {
    accounts: new AccountService(repository),
    sessions,
    merges: new AccountMergeService(repository),
    oauth: {} as AccountRuntime["oauth"],
  };
  const owner = await sessions.issue("account_001", [
    "account:read",
    "account:write",
  ]);
  const other = await sessions.issue("account_002", [
    "account:read",
    "account:write",
  ]);
  const app = createApp((mounted) => {
    mounted.use("*", async (c, next) => {
      c.set("accountRuntime", runtime);
      c.set("worldBackupService", f.service);
      c.set("worldBackupRestoreWorkerAuthenticator", {
        authenticate: async ({ authorization }) =>
          authorization === "Worker fixture"
            ? restoreWorker
            : authorization === "Worker no-scope"
            ? { ...restoreWorker, scopes: [] }
            : undefined,
      });
      await next();
    });
  });
  const create = await app.request(
    "/v1/backup-sources/client_world/world-source_001/backups",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${owner.accessToken}`,
        "content-type": "application/json",
        "idempotency-key": "http_create",
      },
      body: JSON.stringify(command({ idempotencyKey: "ignored_by_route" })),
    },
  );
  assert.equal(create.status, 202);
  const created = await create.json() as { backupId: string; taskId: string };
  assert.ok(created.backupId);
  assert.ok(created.taskId);
  const ownership = await app.request(`/v1/world-backups/${created.backupId}`, {
    headers: { authorization: `Bearer ${other.accessToken}` },
  });
  assert.equal(ownership.status, 403);

  const hosted = await ready(
    f,
    command({
      sourceType: "hosted_server_world",
      sourceId: restoreWorker.serverId,
      idempotencyKey: "hosted_restore",
    }),
  );
  await f.service.restore(
    "account_001",
    hosted.backup.backupId,
    "restore_worker",
  );
  const unauthenticated = await app.request(
    `/v1/internal/world-backups/${hosted.backup.backupId}/events`,
    {
      method: "POST",
      body: JSON.stringify({
        eventId: "worker_event_unauthenticated",
        sequence: 1,
        type: "restore_started",
        occurredAt: "2026-07-22T10:00:00.000Z",
      }),
    },
  );
  assert.equal(unauthenticated.status, 401);
  const missingScope = await app.request(
    `/v1/internal/world-backups/${hosted.backup.backupId}/events`,
    {
      method: "POST",
      headers: { authorization: "Worker no-scope" },
      body: JSON.stringify({
        eventId: "worker_event_no_scope",
        sequence: 1,
        type: "restore_started",
        occurredAt: "2026-07-22T10:00:00.000Z",
      }),
    },
  );
  assert.equal(missingScope.status, 403);
  const internal = await app.request(
    `/v1/internal/world-backups/${hosted.backup.backupId}/events`,
    {
      method: "POST",
      headers: { authorization: "Worker fixture" },
      body: JSON.stringify({
        eventId: "worker_event_001",
        sequence: 1,
        type: "restore_started",
        occurredAt: "2026-07-22T10:00:00.000Z",
      }),
    },
  );
  assert.equal(internal.status, 202);

  const unavailable = createApp((mounted) => {
    mounted.use("*", async (c, next) => {
      c.set("accountRuntime", runtime);
      await next();
    });
  });
  const missingAdapter = await unavailable.request(
    "/v1/backup-sources/client_world/world-source_001/backups",
    { headers: { authorization: `Bearer ${owner.accessToken}` } },
  );
  assert.equal(missingAdapter.status, 503);

  const workerAdapterUnavailable = createApp((mounted) => {
    mounted.use("*", async (c, next) => {
      c.set("accountRuntime", runtime);
      c.set("worldBackupService", f.service);
      await next();
    });
  });
  const missingWorkerAdapter = await workerAdapterUnavailable.request(
    `/v1/internal/world-backups/${hosted.backup.backupId}/events`,
    { method: "POST", body: JSON.stringify({}) },
  );
  assert.equal(missingWorkerAdapter.status, 503);
});
