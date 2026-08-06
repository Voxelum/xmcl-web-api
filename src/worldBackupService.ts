import {
  WORLD_BACKUP_STORAGE_SETTLEMENT_INTERVAL_SECONDS,
  type WorldBackupAsyncTask,
  type WorldBackupFormat,
  type WorldBackupPhysicalStorageObject,
  type WorldBackupResource,
  type WorldBackupSourceType,
  type WorldBackupStorageBillingCursor,
  type WorldBackupStorageUsageEvent,
  type WorldBackupStorageUsageSnapshot,
  type WorldBackupUploadGrant,
} from "./worldBackupContracts.ts";
import {
  worldBackupObjectKey,
  type WorldBackupObjectStorage,
} from "./worldBackupObjectStorage.ts";

export interface WorldBackupSourceVerifier {
  verify(input: {
    accountId: string;
    sourceType: WorldBackupSourceType;
    sourceId: string;
    worldId: string;
  }): Promise<{ allowed: boolean; reason?: string }>;
}

/** BackupStoragePolicy-owned, session-authenticated BackupStoragePolicyV1 reader. */
export interface WorldBackupStoragePolicyReader {
  getPolicy(): Promise<{ freeBytes: 1_073_741_824; policyVersion: 1 }>;
}

export interface WorldBackupStorageAuthorizer {
  authorize(input: {
    accountId: string;
    resource: "storage_retention";
    sourceId: string;
    estimatedQuantity: number;
    unit: "byte_second";
    interval: { startsAt: string; endsAt: string };
    rateVersion: number;
    idempotencyKey: string;
    expiresAt: string;
  }): Promise<
    {
      status: "authorized";
      authorizationId: string;
      rateVersion: number;
      expiresAt: string;
    } | {
      status: "rejected";
      reason: "insufficient_balance" | "unavailable";
    }
  >;
}

export interface WorldBackupStorageUsagePublisher {
  settle(event: WorldBackupStorageUsageEvent): Promise<{
    settlementId: string;
    usageEventId: string;
    action: "continue" | "stop_required";
    status: "settled" | "rejected" | "pending";
    rateVersion: number;
  }>;
}

/**
 * Back this interface with conditional Mongo updates/transactions. The in-memory
 * implementation used by focused tests has identical semantics; process-local
 * maps are deliberately not used by the service itself.
 */
export interface WorldBackupStore {
  createBackup(
    backup: WorldBackupResource,
  ): Promise<"created" | "conflict">;
  getBackup(backupId: string): Promise<WorldBackupResource | undefined>;
  findBackupByCreateKey(
    accountId: string,
    idempotencyKey: string,
  ): Promise<WorldBackupResource | undefined>;
  listSource(
    accountId: string,
    sourceType: WorldBackupSourceType,
    sourceId: string,
  ): Promise<WorldBackupResource[]>;
  listBillable(accountId: string): Promise<WorldBackupResource[]>;
  saveBackup(backup: WorldBackupResource): Promise<void>;
  incrementParentReference(
    backupId: string,
  ): Promise<"updated" | "missing" | "deleted">;
  decrementParentReference(backupId: string): Promise<void>;
  getBillingCursor(
    accountId: string,
  ): Promise<WorldBackupStorageBillingCursor | undefined>;
  saveBillingCursor(cursor: WorldBackupStorageBillingCursor): Promise<void>;
  /**
   * Persists the canonical usage event to WorldBackup's durable outbox and moves the
   * cursor in the same transaction. A delivery retry reuses the event ID.
   */
  commitStorageUsage(input: {
    event: WorldBackupStorageUsageEvent;
    cursor: WorldBackupStorageBillingCursor;
  }): Promise<"committed" | "duplicate" | "conflict">;
  recordRestoreEvent(input: {
    backupId: string;
    eventId: string;
    sequence: number;
  }): Promise<"accepted" | "duplicate" | "out_of_order" | "conflict">;
}

export interface WorldBackupCreateCommand {
  accountId: string;
  sourceType: WorldBackupSourceType;
  sourceId: string;
  worldId: string;
  format: WorldBackupFormat;
  formatVersion: number;
  parentBackupId?: string;
  contentLength: number;
  sha256: string;
  contentType: "application/vnd.xmcl.linear";
  compression: "xmcl_linear";
  explicitManual: true;
  idempotencyKey: string;
  requestId: string;
}

export interface WorldBackupRestoreEvent {
  eventId: string;
  sequence: number;
  type: "restore_started" | "restore_succeeded" | "restore_failed";
  occurredAt: string;
}

export const WORLD_BACKUP_RESTORE_WORKER_SCOPE = "world_backups:restore";

export interface WorldBackupRestoreWorkerPrincipal {
  workerId: string;
  serverId: string;
  leaseId: string;
  scopes: readonly string[];
}

export class WorldBackupError extends Error {
  constructor(
    public readonly code:
      | "invalid_source"
      | "source_forbidden"
      | "invalid_backup"
      | "not_found"
      | "forbidden"
      | "conflict"
      | "parent_in_use"
      | "insufficient_balance"
      | "authorization_unavailable"
      | "upload_verification_failed"
      | "upload_expired"
      | "out_of_order",
    message: string = code,
  ) {
    super(message);
  }
}

const isSourceType = (value: string): value is WorldBackupSourceType =>
  value === "client_world" || value === "hosted_server_world";
const isFormat = (value: string): value is WorldBackupFormat =>
  value === "linear" || value === "layered_linear";
const isSha256 = (value: string) => /^[a-f0-9]{64}$/.test(value);

export class WorldBackupService {
  constructor(
    private readonly store: WorldBackupStore,
    private readonly sources: WorldBackupSourceVerifier,
    private readonly objectStorage: WorldBackupObjectStorage,
    private readonly policyReader: WorldBackupStoragePolicyReader,
    private readonly authorizer: WorldBackupStorageAuthorizer,
    private readonly usagePublisher: WorldBackupStorageUsagePublisher,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly makeId: (prefix: string) => string = (prefix) =>
      `${prefix}_${crypto.randomUUID()}`,
    private readonly settlementIntervalSeconds =
      WORLD_BACKUP_STORAGE_SETTLEMENT_INTERVAL_SECONDS,
    private readonly uploadLifetimeSeconds = 15 * 60,
  ) {}

  async create(
    command: WorldBackupCreateCommand,
  ): Promise<
    { backup: WorldBackupResource; task: WorldBackupAsyncTask }
  > {
    this.validateCreate(command);
    await this.requireSource(command);
    const duplicate = await this.store.findBackupByCreateKey(
      command.accountId,
      command.idempotencyKey,
    );
    if (duplicate) {
      return {
        backup: duplicate,
        task: this.task("create", "succeeded", duplicate, command.requestId),
      };
    }

    if (command.parentBackupId) await this.claimParent(command);
    const now = this.now();
    const backup: WorldBackupResource = {
      backupId: this.makeId("backup"),
      accountId: command.accountId,
      sourceType: command.sourceType,
      sourceId: command.sourceId,
      worldId: command.worldId,
      format: command.format,
      formatVersion: command.formatVersion,
      parentBackupId: command.parentBackupId,
      status: "creating",
      sizeBytes: command.contentLength,
      sha256: command.sha256,
      contentType: command.contentType,
      objectId: this.makeId("object"),
      storageOwnerAccountId: command.accountId,
      verified: false,
      referenceCount: 0,
      lastEventSequence: 0,
      createdAt: now,
      updatedAt: now,
      createIdempotencyKey: command.idempotencyKey,
    };
    if (await this.store.createBackup(backup) !== "created") {
      if (command.parentBackupId) {
        await this.store.decrementParentReference(command.parentBackupId);
      }
      throw new WorldBackupError("conflict");
    }
    return {
      backup,
      task: this.task("create", "succeeded", backup, command.requestId),
    };
  }

  async issueUpload(
    accountId: string,
    backupId: string,
    requestId: string,
  ): Promise<{ grant: WorldBackupUploadGrant; task: WorldBackupAsyncTask }> {
    const backup = await this.ownedBackup(accountId, backupId);
    if (backup.status === "uploading" && backup.uploadGrant) {
      return {
        grant: backup.uploadGrant,
        task: this.task("upload", "succeeded", backup, requestId),
      };
    }
    if (backup.status !== "creating") {
      throw new WorldBackupError("conflict", "backup is not awaiting upload");
    }
    const now = this.now();
    await this.settle(accountId, now);
    const usedBytes = await this.usedBytes(accountId);
    const policy = await this.policyReader.getPolicy();
    const projectedOverage = Math.max(
      0,
      usedBytes + backup.sizeBytes - policy.freeBytes,
    );
    const expiresAt = new Date(
      Date.parse(now) + this.uploadLifetimeSeconds * 1_000,
    ).toISOString();
    if (projectedOverage > 0) {
      const authorized = await this.authorizer.authorize({
        accountId,
        resource: "storage_retention",
        sourceId: this.storageSourceId(accountId),
        estimatedQuantity: projectedOverage * this.settlementIntervalSeconds,
        unit: "byte_second",
        interval: {
          startsAt: now,
          endsAt: new Date(
            Date.parse(now) + this.settlementIntervalSeconds * 1_000,
          ).toISOString(),
        },
        rateVersion: 1,
        idempotencyKey: `${backupId}:upload-reservation`,
        expiresAt,
      });
      if (authorized.status !== "authorized") {
        throw new WorldBackupError(
          authorized.reason === "insufficient_balance"
            ? "insufficient_balance"
            : "authorization_unavailable",
          authorized.reason === "insufficient_balance"
            ? authorized.reason
            : "authorization unavailable",
        );
      }
      backup.authorizationId = authorized.authorizationId;
      backup.authorizationExpiresAt = authorized.expiresAt;
      backup.authorizationRateVersion = authorized.rateVersion;
    }
    const grant = await this.objectStorage.issueSingleUseUpload({
      objectKey: worldBackupObjectKey(accountId, backupId),
      contentLength: backup.sizeBytes,
      sha256: backup.sha256,
      contentType: backup.contentType,
      backupId,
      format: backup.format,
      formatVersion: backup.formatVersion,
      expiresAt,
    });
    backup.status = "uploading";
    backup.uploadExpiresAt = expiresAt;
    backup.uploadGrant = grant;
    backup.updatedAt = now;
    await this.store.saveBackup(backup);
    return {
      grant,
      task: this.task("upload", "succeeded", backup, requestId, { grant }),
    };
  }

  async complete(accountId: string, backupId: string, requestId: string) {
    const backup = await this.ownedBackup(accountId, backupId);
    if (backup.status === "ready") {
      return {
        backup,
        task: this.task("complete", "succeeded", backup, requestId),
      };
    }
    if (backup.status !== "uploading") throw new WorldBackupError("conflict");
    if (
      !backup.uploadExpiresAt ||
      Date.parse(this.now()) > Date.parse(backup.uploadExpiresAt)
    ) {
      throw new WorldBackupError("upload_expired");
    }
    const object = await this.objectStorage.head(
      worldBackupObjectKey(accountId, backupId),
    );
    if (
      !object || object.backupId !== backupId ||
      object.contentLength !== backup.sizeBytes ||
      object.sha256 !== backup.sha256 ||
      object.contentType !== backup.contentType ||
      object.format !== backup.format ||
      object.formatVersion !== backup.formatVersion || !object.formatVerified
    ) {
      throw new WorldBackupError("upload_verification_failed");
    }
    const now = this.now();
    await this.settle(accountId, now);
    backup.status = "ready";
    backup.verified = true;
    backup.uploadGrant = undefined;
    backup.updatedAt = now;
    await this.store.saveBackup(backup);
    return {
      backup,
      task: this.task("complete", "succeeded", backup, requestId),
    };
  }

  async restore(accountId: string, backupId: string, requestId: string) {
    const backup = await this.ownedBackup(accountId, backupId);
    if (backup.status !== "ready") {
      throw new WorldBackupError(
        "conflict",
        "only ready backups can restore",
      );
    }
    backup.status = "restoring";
    backup.updatedAt = this.now();
    await this.store.saveBackup(backup);
    return { backup, task: this.task("restore", "queued", backup, requestId) };
  }

  async handleRestoreEvent(
    backupId: string,
    event: WorldBackupRestoreEvent,
    worker: WorldBackupRestoreWorkerPrincipal,
  ) {
    const before = await this.requiredBackup(backupId);
    if (
      !worker.scopes.includes(WORLD_BACKUP_RESTORE_WORKER_SCOPE) ||
      before.sourceType !== "hosted_server_world" ||
      before.sourceId !== worker.serverId
    ) {
      throw new WorldBackupError(
        "source_forbidden",
        "worker is not authorized for this hosted world",
      );
    }
    if (event.type === "restore_started" && before.status !== "restoring") {
      throw new WorldBackupError("conflict");
    }
    if (event.type !== "restore_started" && before.status !== "restoring") {
      throw new WorldBackupError("conflict");
    }
    const result = await this.store.recordRestoreEvent({
      backupId,
      eventId: event.eventId,
      sequence: event.sequence,
    });
    if (result === "duplicate") return { duplicate: true };
    if (result === "out_of_order") throw new WorldBackupError("out_of_order");
    if (result !== "accepted") throw new WorldBackupError("conflict");
    const backup = before;
    if (event.type === "restore_started") {
    } else {
      backup.status = event.type === "restore_succeeded" ? "ready" : "failed";
      backup.updatedAt = event.occurredAt;
      await this.store.saveBackup(backup);
    }
    return { duplicate: false };
  }

  async delete(accountId: string, backupId: string, requestId: string) {
    const backup = await this.ownedBackup(accountId, backupId);
    if (backup.status === "deleted") {
      return {
        backup,
        task: this.task("delete", "succeeded", backup, requestId),
      };
    }
    if (backup.referenceCount > 0) {
      throw new WorldBackupError("parent_in_use");
    }
    if (backup.status === "restoring") throw new WorldBackupError("conflict");
    const now = this.now();
    await this.settle(accountId, now);
    await this.objectStorage.delete(worldBackupObjectKey(accountId, backupId));
    backup.status = "deleted";
    backup.updatedAt = now;
    await this.store.saveBackup(backup);
    if (backup.parentBackupId) {
      await this.store.decrementParentReference(backup.parentBackupId);
    }
    return { backup, task: this.task("delete", "queued", backup, requestId) };
  }

  async get(accountId: string, backupId: string) {
    return await this.ownedBackup(accountId, backupId);
  }

  async list(accountId: string, sourceType: string, sourceId: string) {
    if (!isSourceType(sourceType)) {
      throw new WorldBackupError("invalid_source");
    }
    const allowed = await this.sources.verify({
      accountId,
      sourceType,
      sourceId,
      worldId: "",
    });
    if (!allowed.allowed) {
      throw new WorldBackupError("source_forbidden", allowed.reason);
    }
    return await this.store.listSource(accountId, sourceType, sourceId);
  }

  async storageUsage(
    accountId: string,
  ): Promise<WorldBackupStorageUsageSnapshot> {
    const policy = await this.policyReader.getPolicy();
    const usedBytes = await this.usedBytes(accountId);
    return {
      accountId,
      policy,
      usedBytes,
      overageBytes: Math.max(0, usedBytes - policy.freeBytes),
      lastSettledAt:
        (await this.store.getBillingCursor(accountId))?.lastSettledAt ??
          this.intervalStart(this.now()),
      settlementIntervalSeconds: this.settlementIntervalSeconds,
      countedObjects: await this.countedObjects(accountId),
    };
  }

  private async claimParent(command: WorldBackupCreateCommand) {
    const parent = await this.requiredBackup(command.parentBackupId!);
    if (
      parent.accountId !== command.accountId ||
      parent.sourceType !== command.sourceType ||
      parent.sourceId !== command.sourceId ||
      parent.worldId !== command.worldId || parent.status !== "ready"
    ) {
      throw new WorldBackupError(
        "invalid_backup",
        "parent is not a ready backup of this world",
      );
    }
    await this.settle(command.accountId, this.now());
    if (
      await this.store.incrementParentReference(parent.backupId) !== "updated"
    ) {
      throw new WorldBackupError(
        "parent_in_use",
        "parent cannot be referenced",
      );
    }
  }

  private validateCreate(command: WorldBackupCreateCommand) {
    if (!isSourceType(command.sourceType)) {
      throw new WorldBackupError("invalid_source");
    }
    if (
      !isFormat(command.format) || !command.explicitManual ||
      command.compression !== "xmcl_linear" ||
      command.contentType !== "application/vnd.xmcl.linear" ||
      !Number.isInteger(command.formatVersion) ||
      command.formatVersion < 1 ||
      !Number.isSafeInteger(command.contentLength) ||
      command.contentLength < 1 ||
      !isSha256(command.sha256) || !command.worldId || !command.sourceId ||
      !command.idempotencyKey
    ) {
      throw new WorldBackupError("invalid_backup");
    }
    if (
      (command.format === "layered_linear") !== Boolean(command.parentBackupId)
    ) {
      throw new WorldBackupError(
        "invalid_backup",
        "layered backups require exactly one parent",
      );
    }
  }

  private async requireSource(command: WorldBackupCreateCommand) {
    const allowed = await this.sources.verify(command);
    if (!allowed.allowed) {
      throw new WorldBackupError("source_forbidden", allowed.reason);
    }
  }

  private async ownedBackup(accountId: string, backupId: string) {
    const backup = await this.requiredBackup(backupId);
    if (backup.accountId !== accountId) {
      throw new WorldBackupError("forbidden");
    }
    return backup;
  }

  private async requiredBackup(backupId: string) {
    const backup = await this.store.getBackup(backupId);
    if (!backup) throw new WorldBackupError("not_found");
    return backup;
  }

  private async usedBytes(accountId: string) {
    return (await this.countedObjects(accountId)).reduce(
      (total, object) => total + object.physicalBytes,
      0,
    );
  }

  private async settle(accountId: string, settledAt: string) {
    const cursor = await this.store.getBillingCursor(accountId);
    if (!cursor) {
      await this.store.saveBillingCursor({
        accountId,
        lastSettledAt: this.intervalStart(settledAt),
        lastUsageSequence: 0,
      });
      return;
    }
    const elapsedSeconds = Math.floor(
      (Date.parse(settledAt) - Date.parse(cursor.lastSettledAt)) / 1_000,
    );
    if (elapsedSeconds <= 0) return;
    const policy = await this.policyReader.getPolicy();
    const overageBytes = Math.max(
      0,
      await this.usedBytes(accountId) - policy.freeBytes,
    );
    if (overageBytes > 0) {
      const authorization = await this.currentAuthorization(accountId);
      if (
        !authorization || !authorization.authorizationId ||
        !authorization.authorizationRateVersion
      ) {
        throw new WorldBackupError(
          "authorization_unavailable",
          "a current storage authorization is required",
        );
      }
      const sequence = cursor.lastUsageSequence + 1;
      const event: WorldBackupStorageUsageEvent = {
        eventType: "usage.recorded.v1",
        eventId:
          `storage-retention:${accountId}:${cursor.lastSettledAt}:${settledAt}`,
        schemaVersion: 1,
        accountId,
        authorizationId: authorization.authorizationId,
        resource: "storage_retention",
        quantity: overageBytes * elapsedSeconds,
        unit: "byte_second",
        sourceId: this.storageSourceId(accountId),
        rateVersion: authorization.authorizationRateVersion,
        sequence,
        intervalStart: cursor.lastSettledAt,
        intervalEnd: settledAt,
        occurredAt: settledAt,
        idempotencyKey:
          `storage-retention:${accountId}:${cursor.lastSettledAt}:${settledAt}`,
      };
      const result = await this.usagePublisher.settle(event);
      if (
        result.status !== "settled" || result.action !== "continue" ||
        result.rateVersion !== event.rateVersion
      ) {
        throw new WorldBackupError(
          "authorization_unavailable",
          "storage settlement was not accepted",
        );
      }
      const committed = await this.store.commitStorageUsage({
        event,
        cursor: {
          accountId,
          lastSettledAt: settledAt,
          lastUsageSequence: sequence,
        },
      });
      if (committed === "conflict") {
        throw new WorldBackupError(
          "conflict",
          "storage usage outbox conflict",
        );
      }
      return;
    }
    await this.store.saveBillingCursor({ ...cursor, lastSettledAt: settledAt });
  }

  private async countedObjects(
    accountId: string,
  ): Promise<WorldBackupPhysicalStorageObject[]> {
    return (await this.store.listBillable(accountId))
      .filter((backup) =>
        backup.verified && backup.storageOwnerAccountId === accountId &&
        backup.status !== "deleted"
      )
      .map((backup) => ({
        objectId: backup.objectId,
        storageOwnerAccountId: backup.storageOwnerAccountId,
        physicalBytes: backup.sizeBytes,
        activeReferenceCount: backup.referenceCount + 1,
        verified: true,
      }));
  }

  private async currentAuthorization(accountId: string) {
    const now = Date.parse(this.now());
    return (await this.store.listBillable(accountId))
      .find((backup) =>
        backup.verified && backup.authorizationId &&
        backup.authorizationRateVersion &&
        backup.authorizationExpiresAt &&
        Date.parse(backup.authorizationExpiresAt) > now
      );
  }

  private storageSourceId(accountId: string) {
    return `storage:${accountId}`;
  }

  private intervalStart(value: string) {
    const milliseconds = Date.parse(value);
    return new Date(
      Math.floor(milliseconds / (this.settlementIntervalSeconds * 1_000)) *
        this.settlementIntervalSeconds * 1_000,
    ).toISOString();
  }

  private task<T>(
    operation: "create" | "upload" | "complete" | "restore" | "delete",
    status: WorldBackupAsyncTask<T>["status"],
    backup: WorldBackupResource,
    requestId: string,
    result?: T,
  ): WorldBackupAsyncTask<T> {
    const now = this.now();
    return {
      taskId: `task_${operation}_${backup.backupId}`,
      requestId,
      status,
      resource: { type: "world_backup", id: backup.backupId },
      result,
      createdAt: now,
      updatedAt: now,
    };
  }
}
