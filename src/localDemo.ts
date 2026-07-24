import { AccountMergeService } from "./lib/accountMerge.ts";
import {
  AccountError,
  AccountService,
  MemoryAccountRepository,
} from "./lib/account.ts";
import type { AccountRuntime } from "./lib/accountRuntime.ts";
import type { AiServiceDependencies } from "./lib/ai/service.ts";
import type {
  AiRequestClaim,
  AiRequestRecord,
  AiRequestRepository,
} from "./lib/ai/service.ts";
import type { AuditEvent, AuditLog } from "./lib/audit.ts";
import { BillingService } from "./lib/billing.ts";
import { InMemoryModpackDeploymentRepository } from "./lib/deploymentTasks.ts";
import type {
  ModpackArchiveStore,
  ModpackDeploymentTaskDispatcher,
  ServerCompatibilityGateway,
  WorkerDeploymentGateway,
} from "./lib/deploymentTasks.ts";
import { MemoryBillingStore } from "./lib/ledger.ts";
import {
  MemorySharedHostingSchedulerRepository,
  SharedHostingScheduler,
} from "./lib/sharedHostingScheduler.ts";
import {
  SHARED_HOSTING_RATES,
  SharedHostingService,
} from "./lib/sharedHosting.ts";
import { createModpackDeploymentRuntime } from "./lib/modpackDeploymentRuntime.ts";
import { createStoredZip, jsonBytes } from "./lib/modpackTestFixtures.ts";
import type {
  AdminOperation,
  AdminOperationCompletedEvent,
  AdminOperationRepository,
  AdminPrincipal,
} from "./lib/operations.ts";
import { AdminOperationService } from "./lib/operations.ts";
import type {
  OAuthProvider,
  OAuthProviderAdapter,
  OAuthRegistry,
  VerifiedIdentity,
} from "./lib/oauth/types.ts";
import {
  FakePayPalProvider,
  FakePayPalWebhookVerifier,
  PayPalService,
} from "./lib/paypal.ts";
import { MemoryServerRepository } from "./lib/serverRepository.ts";
import { createServerControlRuntime } from "./lib/serverControlRuntime.ts";
import { type PublicSession, USER_SESSION_SCOPES } from "./lib/session.ts";
import { UsageSettlementService } from "./lib/usageSettlement.ts";
import type { VultrAdapter, VultrInstance } from "./lib/vultr.ts";
import {
  WORLD_BACKUP_RESTORE_WORKER_SCOPE,
  WorldBackupService,
  type WorldBackupStore,
} from "./lib/worldBackupService.ts";
import type {
  WorldBackupObjectMetadata,
  WorldBackupObjectStorage,
} from "./lib/worldBackupObjectStorage.ts";
import type {
  WorldBackupResource,
  WorldBackupStorageBillingCursor,
  WorldBackupStorageUsageEvent,
  WorldBackupUploadGrant,
} from "./lib/worldBackupContracts.ts";
import { createWorkerRuntime } from "./lib/worker/runtime.ts";
import type { LeaseBinding } from "./lib/worker/service.ts";
import { MemoryWorkerRepository } from "./lib/workerRepository.ts";
import { createApp } from "./app.ts";
import type { AppEnv } from "./types.ts";

export const LOCAL_DEMO_PROFILE = "xmcl-local-demo";
export const DEMO_ACCOUNT_ID = "demo-user";
export const DEMO_SERVICE_ACCOUNT_ID = "demo-service";
export const DEMO_SERVER_ID = "demo-server";
export const DEMO_LEASE_ID = "demo-lease";

/**
 * These values are intentionally public and are accepted only by
 * createLocalDemoApp. They are never read by production composition.
 */
export const LOCAL_DEMO_CREDENTIALS = Object.freeze({
  userAccessToken: "demo-user-token",
  userRefreshToken: "demo-user-refresh-token",
  userSessionId: "demo-user-session",
  serviceAccessToken: "demo-service-token",
  adminAccessToken: "demo-admin-token",
  workerBootstrapCredential: "demo-worker-bootstrap",
  restoreWorkerAccessToken: "demo-restore-worker-token",
});

export interface LocalDemoApp {
  app: ReturnType<typeof createApp>;
  archive: { sha256: string; sizeBytes: number };
}

class DemoSessionService {
  private readonly revoked = new Set<string>();

  async verify(token: string) {
    const user = token === LOCAL_DEMO_CREDENTIALS.userAccessToken;
    const service = token === LOCAL_DEMO_CREDENTIALS.serviceAccessToken;
    if (!user && !service) {
      throw new AccountError(401, "invalid_access_token");
    }
    const sessionId = user
      ? LOCAL_DEMO_CREDENTIALS.userSessionId
      : "demo-service-session";
    if (this.revoked.has(sessionId)) {
      throw new AccountError(401, "session_revoked");
    }
    const now = "2026-07-22T00:00:00.000Z";
    return {
      sessionId,
      familyId: user ? "demo-user-family" : "demo-service-family",
      accountId: user ? DEMO_ACCOUNT_ID : DEMO_SERVICE_ACCOUNT_ID,
      scopes: user ? [...USER_SESSION_SCOPES] : ["billing:internal"],
      issuedAt: now,
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
  }

  async issue(
    accountId: string,
    scopes = USER_SESSION_SCOPES,
  ): Promise<PublicSession> {
    const isUser = accountId === DEMO_ACCOUNT_ID;
    const now = "2026-07-22T00:00:00.000Z";
    return {
      sessionId: isUser
        ? LOCAL_DEMO_CREDENTIALS.userSessionId
        : `demo-session-${accountId}`,
      familyId: isUser ? "demo-user-family" : `demo-family-${accountId}`,
      accountId,
      scopes: [...scopes],
      issuedAt: now,
      expiresAt: "2099-01-01T00:00:00.000Z",
      accessToken: isUser
        ? LOCAL_DEMO_CREDENTIALS.userAccessToken
        : `demo-access-${accountId}`,
      refreshToken: isUser
        ? LOCAL_DEMO_CREDENTIALS.userRefreshToken
        : `demo-refresh-${accountId}`,
    };
  }

  async refresh(
    sessionId: string,
    refreshToken: string,
  ): Promise<PublicSession> {
    if (
      sessionId !== LOCAL_DEMO_CREDENTIALS.userSessionId ||
      refreshToken !== LOCAL_DEMO_CREDENTIALS.userRefreshToken ||
      this.revoked.has(sessionId)
    ) {
      throw new AccountError(401, "invalid_refresh_token");
    }
    return await this.issue(DEMO_ACCOUNT_ID);
  }

  async revoke(accountId: string, sessionId: string | "all") {
    if (accountId !== DEMO_ACCOUNT_ID) {
      throw new AccountError(404, "account_not_found");
    }
    if (
      sessionId !== "all" &&
      sessionId !== LOCAL_DEMO_CREDENTIALS.userSessionId
    ) {
      throw new AccountError(404, "session_not_found");
    }
    this.revoked.add(LOCAL_DEMO_CREDENTIALS.userSessionId);
  }
}

function demoOAuth(provider: OAuthProvider): OAuthProviderAdapter {
  return {
    declaration: {
      provider,
      issuer: "https://local-demo.invalid",
      authorizationEndpoint: `https://local-demo.invalid/oauth/${provider}`,
      tokenEndpoint: "https://local-demo.invalid/token",
      userInfoEndpoint: "https://local-demo.invalid/userinfo",
      clientId: "local-demo-client",
      audience: "local-demo",
      subjectClaim: "sub",
      scopes: ["profile"],
      redirectUris: ["https://local-demo.invalid/callback"],
      credentialVerification: "provider_userinfo",
      launcherAvailable: true,
    },
    authorizationUrl(input) {
      const url = new URL(`https://local-demo.invalid/oauth/${provider}`);
      url.searchParams.set("state", input.state);
      url.searchParams.set("redirect_uri", input.redirectUri);
      return url.toString();
    },
    async exchange(input): Promise<VerifiedIdentity> {
      if (!input.code) {
        throw new AccountError(401, "invalid_provider_credential");
      }
      return {
        provider,
        subject: `local-demo:${provider}:${input.code}`,
        displayName: `Local demo ${provider}`,
      };
    },
    async verifyLauncherCredential(input): Promise<VerifiedIdentity> {
      if (!input.accessToken) {
        throw new AccountError(401, "invalid_provider_credential");
      }
      return {
        provider,
        subject: `local-demo:${provider}:${input.accessToken}`,
        displayName: `Local demo ${provider}`,
      };
    },
  };
}

class DemoProvider implements VultrAdapter {
  private readonly instances = new Map<string, VultrInstance>();
  private readonly snapshots = new Set<string>();

  async validateCapacity(plan: string) {
    if (plan !== "vc2-2c-4gb" && plan !== "vc2-4c-8gb") {
      throw new Error("local demo supports vc2-2c-4gb and vc2-4c-8gb");
    }
  }

  async createInstance(input: {
    serverId: string;
    plan: string;
    userData: string;
  }) {
    await this.validateCapacity(input.plan);
    const instance: VultrInstance = {
      id: `demo-instance-${input.serverId}`,
      region: "taipei",
      plan: input.plan,
      label: input.serverId,
      status: "active",
      powerStatus: "running",
      serverStatus: "ok",
      address: "127.0.0.1",
    };
    this.instances.set(instance.id, instance);
    return structuredClone(instance);
  }

  async reconcileCreate(serverId: string) {
    return [...this.instances.values()].find((item) => item.label === serverId);
  }

  async createSnapshot(instanceId: string) {
    if (!this.instances.has(instanceId)) {
      throw new Error("local demo instance does not exist");
    }
    const snapshotId = `demo-snapshot-${instanceId}`;
    this.snapshots.add(snapshotId);
    return { snapshotId };
  }

  async getInstance(instanceId: string) {
    const instance = this.instances.get(instanceId);
    return instance && structuredClone(instance);
  }

  async start(instanceId: string) {
    const instance = this.instances.get(instanceId);
    if (instance) instance.powerStatus = "running";
  }

  async halt(instanceId: string) {
    const instance = this.instances.get(instanceId);
    if (instance) instance.powerStatus = "stopped";
  }

  async reboot(instanceId: string) {
    const instance = this.instances.get(instanceId);
    if (instance) instance.powerStatus = "running";
  }

  async delete(instanceId: string) {
    this.instances.delete(instanceId);
  }
}

class DemoBackupStore implements WorldBackupStore {
  readonly backups = new Map<string, WorldBackupResource>();
  readonly createKeys = new Map<string, string>();
  readonly cursors = new Map<string, WorldBackupStorageBillingCursor>();
  readonly restoreEvents = new Map<
    string,
    { eventId: string; sequence: number }
  >();
  readonly storageUsage = new Map<string, WorldBackupStorageUsageEvent>();

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
    const backupId = this.createKeys.get(`${accountId}:${idempotencyKey}`);
    return backupId ? await this.getBackup(backupId) : undefined;
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
    const backup = this.backups.get(backupId);
    if (!backup) return "missing" as const;
    if (backup.status === "deleted") return "deleted" as const;
    backup.referenceCount += 1;
    return "updated" as const;
  }

  async decrementParentReference(backupId: string) {
    const backup = this.backups.get(backupId);
    if (backup) backup.referenceCount -= 1;
  }

  async getBillingCursor(accountId: string) {
    const cursor = this.cursors.get(accountId);
    return cursor && structuredClone(cursor);
  }

  async saveBillingCursor(cursor: WorldBackupStorageBillingCursor) {
    this.cursors.set(cursor.accountId, structuredClone(cursor));
  }

  async commitStorageUsage(input: {
    event: WorldBackupStorageUsageEvent;
    cursor: WorldBackupStorageBillingCursor;
  }) {
    const existing = this.storageUsage.get(input.event.eventId);
    if (existing) {
      return JSON.stringify(existing) === JSON.stringify(input.event)
        ? "duplicate" as const
        : "conflict" as const;
    }
    this.storageUsage.set(input.event.eventId, structuredClone(input.event));
    this.cursors.set(input.cursor.accountId, structuredClone(input.cursor));
    return "committed" as const;
  }

  async recordRestoreEvent(input: {
    backupId: string;
    eventId: string;
    sequence: number;
  }) {
    if (!this.backups.has(input.backupId)) return "conflict" as const;
    const existing = this.restoreEvents.get(input.backupId);
    if (existing?.eventId === input.eventId) return "duplicate" as const;
    if (existing && input.sequence <= existing.sequence) {
      return "out_of_order" as const;
    }
    this.restoreEvents.set(input.backupId, {
      eventId: input.eventId,
      sequence: input.sequence,
    });
    return "accepted" as const;
  }
}

class DemoObjectStorage implements WorldBackupObjectStorage {
  private readonly objects = new Map<string, WorldBackupObjectMetadata>();

  async issueSingleUseUpload(
    input: Omit<WorldBackupObjectMetadata, "formatVerified"> & {
      expiresAt: string;
    },
  ): Promise<WorldBackupUploadGrant> {
    // Local demo accepts the object immediately. It deliberately does not issue
    // a network-capable URL or contact an object-storage provider.
    this.objects.set(input.objectKey, {
      ...input,
      formatVerified: true,
    });
    return {
      backupId: input.backupId,
      url: `mock://local-demo-object-storage/${input.backupId}`,
      expiresAt: input.expiresAt,
      contentLength: input.contentLength,
      sha256: input.sha256,
      requiredHeaders: {
        "content-length": String(input.contentLength),
        "content-type": input.contentType,
      },
    };
  }

  async head(objectKey: string) {
    const object = this.objects.get(objectKey);
    return object && structuredClone(object);
  }

  async delete(objectKey: string) {
    this.objects.delete(objectKey);
  }
}

class DemoAiRequests implements AiRequestRepository {
  private readonly records = new Map<
    string,
    AiRequestClaim | AiRequestRecord
  >();

  async claim(claim: AiRequestClaim) {
    const key = `${claim.accountId}:${claim.idempotencyKey}`;
    const existing = this.records.get(key);
    if (!existing) {
      this.records.set(key, structuredClone(claim));
      return { status: "claimed" as const };
    }
    if (
      !("result" in existing) ||
      existing.requestFingerprint !== claim.requestFingerprint
    ) {
      return { status: "conflict" as const };
    }
    return { status: "existing" as const, record: structuredClone(existing) };
  }

  async persistProviderResult(record: AiRequestRecord) {
    this.records.set(
      `${record.accountId}:${record.idempotencyKey}`,
      structuredClone(record),
    );
  }

  async markSettled(
    accountId: string,
    idempotencyKey: string,
    eventId: string,
  ) {
    const record = this.records.get(`${accountId}:${idempotencyKey}`);
    if (!record || !("result" in record)) {
      throw new Error("demo AI request missing");
    }
    if (!record.settledEventIds.includes(eventId)) {
      record.settledEventIds.push(eventId);
    }
    record.status = record.settledEventIds.length === record.events.length
      ? "completed"
      : "pending_settlement";
    return structuredClone(record);
  }

  async release(claim: AiRequestClaim) {
    const key = `${claim.accountId}:${claim.idempotencyKey}`;
    const record = this.records.get(key);
    if (record && !("result" in record)) this.records.delete(key);
  }
}

class DemoOperations implements AdminOperationRepository {
  readonly values = new Map<string, AdminOperation>();

  async create(operation: AdminOperation) {
    const existing = this.values.get(operation.operationId);
    if (!existing) {
      this.values.set(operation.operationId, structuredClone(operation));
      return { status: "created" as const, operation };
    }
    return existing.requestFingerprint === operation.requestFingerprint
      ? { status: "replay" as const, operation: structuredClone(existing) }
      : { status: "conflict" as const };
  }

  async get(operationId: string) {
    const operation = this.values.get(operationId);
    return operation && structuredClone(operation);
  }

  async markRequestedPublished(operationId: string, publishedAt: string) {
    const operation = this.values.get(operationId);
    if (!operation) throw new Error("operation not found");
    operation.requestedPublishedAt = publishedAt;
  }

  async saveCompletion(
    operationId: string,
    completion: AdminOperationCompletedEvent,
    status: AdminOperation["status"],
  ) {
    const operation = this.values.get(operationId);
    if (!operation) throw new Error("operation not found");
    if (!operation.completion) {
      operation.completion = structuredClone(completion);
      operation.status = status;
      return "accepted" as const;
    }
    return JSON.stringify(operation.completion) === JSON.stringify(completion)
      ? "duplicate" as const
      : "conflict" as const;
  }

  async resolve(input: {
    operationId: string;
    resolutionId: string;
    requestFingerprint: string;
    resolvedAt: string;
  }) {
    const operation = this.values.get(input.operationId);
    if (!operation) return { status: "not_found" as const };
    if (operation.manualResolution) {
      return operation.manualResolution.requestFingerprint ===
          input.requestFingerprint
        ? { status: "replay" as const, operation: structuredClone(operation) }
        : { status: "conflict" as const };
    }
    operation.manualResolution = {
      resolutionId: input.resolutionId,
      requestFingerprint: input.requestFingerprint,
      resolvedAt: input.resolvedAt,
    };
    operation.status = "resolved";
    return {
      status: "resolved" as const,
      operation: structuredClone(operation),
    };
  }

  async pendingDispatches() {
    return [...this.values.values()].filter((item) =>
      !item.requestedPublishedAt
    )
      .map((item) => structuredClone(item));
  }

  async enqueueManual() {}
}

class DemoAuditLog implements AuditLog {
  readonly events: AuditEvent[] = [];

  async append(event: AuditEvent) {
    this.events.push(structuredClone(event));
  }
}

function archiveManifest() {
  return {
    formatVersion: 1,
    game: "minecraft",
    versionId: "local-demo-pack",
    dependencies: {
      minecraft: "1.21.1",
      "fabric-loader": "0.16.10",
    },
    xmcl: { javaMajor: 21, templateId: "fabric-1.21" },
    files: [{
      path: "mods/local-demo.jar",
      provider: "modrinth",
      projectId: "local-demo-project",
      fileId: "local-demo-file",
      filename: "local-demo.jar",
    }],
  };
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

/**
 * Builds the local-only app. It accepts no configuration, does not read
 * environment variables, and contains no network-capable provider adapters.
 */
export async function createLocalDemoApp(): Promise<LocalDemoApp> {
  const now = () => new Date().toISOString();
  let id = 0;
  const nextId = (prefix: string) => `demo-${prefix}-${++id}`;

  const accountsRepository = new MemoryAccountRepository();
  await accountsRepository.saveAccount({
    accountId: DEMO_ACCOUNT_ID,
    status: "active",
    createdAt: "2026-07-22T00:00:00.000Z",
    identities: [{
      provider: "microsoft",
      subject: "local-demo-user",
      displayName: "Local Demo User",
      linkedBy: "launcher_bootstrap",
      linkedAt: "2026-07-22T00:00:00.000Z",
    }],
  });
  await accountsRepository.saveAccount({
    accountId: DEMO_SERVICE_ACCOUNT_ID,
    status: "active",
    createdAt: "2026-07-22T00:00:00.000Z",
    identities: [],
  });
  const sessions = new DemoSessionService();
  const oauth = Object.fromEntries(
    (["microsoft", "modrinth", "google", "discord"] as const).map((
      provider,
    ) => [
      provider,
      demoOAuth(provider),
    ]),
  ) as OAuthRegistry;
  const accountRuntime: AccountRuntime = {
    accounts: new AccountService(accountsRepository),
    sessions: sessions as unknown as AccountRuntime["sessions"],
    merges: new AccountMergeService(accountsRepository),
    oauth,
  };

  const billingStore = new MemoryBillingStore();
  const billing = new BillingService(billingStore, {
    currency: "USD",
    rates: [
      ...SHARED_HOSTING_RATES,
      {
        resource: "server_time",
        unit: "hour",
        rateVersion: 1,
        amountMinorPerUnit: 6,
        effectiveAt: "2026-01-01T00:00:00.000Z",
      },
      {
        resource: "ai_request",
        unit: "request",
        rateVersion: 7,
        amountMinorPerUnit: 10,
        effectiveAt: "2026-01-01T00:00:00.000Z",
      },
      {
        resource: "ai_tokens",
        unit: "token",
        rateVersion: 8,
        amountMinorPerUnit: 1,
        effectiveAt: "2026-01-01T00:00:00.000Z",
      },
      {
        resource: "storage_retention",
        unit: "byte_second",
        rateVersion: 1,
        amountMinorPerUnit: 1,
        effectiveAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    createId: nextId,
  });
  await billing.applyAdminOperation({
    operationId: "demo-initial-credit",
    action: "balance_adjust",
    accountId: DEMO_ACCOUNT_ID,
    amountMinor: 1_000_000,
    reason: "Local demo opening balance",
  });
  const usage = new UsageSettlementService(billingStore, billing, {
    createId: nextId,
  });
  const sharedHosting = new SharedHostingService(billingStore, {
    now: () => new Date(),
    createId: nextId,
  });
  const sharedHostingScheduler = new SharedHostingScheduler(
    new MemorySharedHostingSchedulerRepository(),
    sharedHosting,
    { dispatch: async () => {} },
    undefined,
    { region: "local", createId: nextId },
  );
  await sharedHostingScheduler.registerNode({
    nodeId: "demo-shared-node",
    region: "local",
    status: "ready",
    totalMemoryMiB: 12 * 1024,
    totalSharedCpu: 8,
    totalWorkspaceGiB: 128,
  });
  const paypal = new PayPalService(
    billing,
    new FakePayPalProvider(),
    new FakePayPalWebhookVerifier(),
  );

  const serverRepository = new MemoryServerRepository();
  let allocateDemoServerId = true;
  let allocateDemoLeaseId = true;
  const serverControlId = (prefix: "server" | "task" | "lease") => {
    if (prefix === "server" && allocateDemoServerId) {
      allocateDemoServerId = false;
      return DEMO_SERVER_ID;
    }
    if (prefix === "lease" && allocateDemoLeaseId) {
      allocateDemoLeaseId = false;
      return DEMO_LEASE_ID;
    }
    return nextId(prefix);
  };
  const serverRuntime = createServerControlRuntime({
    repository: serverRepository,
    vultr: new DemoProvider(),
    billingAuthorizations: {
      async authorize(request) {
        const authorization = await usage.authorize(
          DEMO_SERVICE_ACCOUNT_ID,
          request,
        );
        return { ...authorization, resource: "server_time" as const };
      },
      async release(authorizationId, idempotencyKey) {
        await usage.release(
          DEMO_SERVICE_ACCOUNT_ID,
          authorizationId,
          idempotencyKey,
        );
      },
    },
    workerStops: { requestGracefulStop: async () => "accepted" },
    worldBackupDeletion: { confirmServerDeletion: async () => "confirmed" },
    expiredStops: { listExpiredStops: async () => [] },
    adminOperationService: { complete: async () => {} },
    id: serverControlId,
  });

  const provisioning = await serverRuntime.service.create(
    DEMO_ACCOUNT_ID,
    { plan: "vc2-2c-4gb" },
    {
      idempotencyKey: "demo-server-provisioning",
      requestId: "demo-server-provisioning",
    },
  );
  await serverRuntime.service.executeTask(DEMO_ACCOUNT_ID, provisioning.taskId);
  const startup = await serverRuntime.service.start(
    DEMO_ACCOUNT_ID,
    DEMO_SERVER_ID,
    {
      idempotencyKey: "demo-server-startup",
      requestId: "demo-server-startup",
    },
  );
  await serverRuntime.service.executeTask(DEMO_ACCOUNT_ID, startup.taskId);
  await serverRuntime.service.handleWorkerEvent({
    eventId: "demo-server-ready",
    schemaVersion: 1,
    accountId: DEMO_ACCOUNT_ID,
    serverId: DEMO_SERVER_ID,
    sequence: 1,
    type: "worker.healthy",
    observedAt: now(),
  });
  const activeLease = (await serverRepository.read(DEMO_ACCOUNT_ID)).leases
    .find(
      (candidate) =>
        candidate.serverId === DEMO_SERVER_ID &&
        candidate.leaseId === DEMO_LEASE_ID && candidate.status === "active",
    );
  if (!activeLease) {
    throw new Error("local demo server did not receive an active worker lease");
  }
  const lease: LeaseBinding = {
    serverId: DEMO_SERVER_ID,
    leaseId: DEMO_LEASE_ID,
    accountId: DEMO_ACCOUNT_ID,
    authorizationId: activeLease.authorizationId,
    rateVersion: 1,
    status: "active",
  };
  const workerRuntime = createWorkerRuntime({
    repository: new MemoryWorkerRepository(),
    serverControlLeases: {
      getLease(serverId, leaseId) {
        return Promise.resolve(
          serverId === lease.serverId && leaseId === lease.leaseId
            ? structuredClone(lease)
            : undefined,
        );
      },
    },
    billingSettlements: {
      async settle(event) {
        const result = await usage.settle(DEMO_SERVICE_ACCOUNT_ID, event);
        return {
          settlementId: result.settlementId,
          usageEventId: result.usageEventId,
          status: result.status,
          action: result.action,
        };
      },
    },
    bootstrap: {
      authenticate: async (input) =>
        input.credential === LOCAL_DEMO_CREDENTIALS.workerBootstrapCredential &&
        input.serverId === DEMO_SERVER_ID && input.leaseId === DEMO_LEASE_ID,
    },
    events: { publish: async () => {} },
    operations: { receive: async () => {} },
  });

  const backupStore = new DemoBackupStore();
  const worldBackups = new WorldBackupService(
    backupStore,
    {
      verify: async (input) => ({
        allowed: input.accountId === DEMO_ACCOUNT_ID &&
          (input.sourceType === "client_world" ||
            input.sourceId === DEMO_SERVER_ID),
        reason: "local_demo_source_not_owned",
      }),
    },
    new DemoObjectStorage(),
    {
      getPolicy: async () => ({ freeBytes: 1_073_741_824, policyVersion: 1 }),
    },
    {
      async authorize() {
        return {
          status: "authorized" as const,
          authorizationId: "demo-storage-authorization",
          rateVersion: 1,
          expiresAt: "2099-01-01T00:00:00.000Z",
        };
      },
    },
    {
      async settle(event) {
        return {
          settlementId: `demo-storage-settlement-${event.eventId}`,
          usageEventId: event.eventId,
          status: "settled" as const,
          action: "continue" as const,
          rateVersion: event.rateVersion,
        };
      },
    },
    now,
    nextId,
  );

  const ai: AiServiceDependencies = {
    models: [{
      capability: "troubleshoot",
      model: "local-demo-small",
      maxInputLength: 1_000,
      maxOutputTokens: 100,
      maxTotalTokens: 1_100,
      rateVersions: { ai_request: 7, ai_tokens: 8 },
    }],
    requests: new DemoAiRequests(),
    authorizations: {
      async authorize(request) {
        const authorization = await usage.authorize(
          DEMO_SERVICE_ACCOUNT_ID,
          request,
        );
        return {
          ...authorization,
          resource: request.resource,
          unit: request.unit,
        };
      },
      async release(authorizationId, idempotencyKey) {
        const authorization = await usage.release(
          DEMO_SERVICE_ACCOUNT_ID,
          authorizationId,
          idempotencyKey,
        );
        return {
          ...authorization,
          resource: authorization.resource as "ai_request" | "ai_tokens",
          unit: authorization.resource === "ai_request"
            ? "request" as const
            : "token" as const,
        };
      },
      settle: (event) => usage.settle(DEMO_SERVICE_ACCOUNT_ID, event),
    },
    now: () => new Date(),
    provider: {
      async request(input) {
        return {
          providerRequestId: `local-demo-ai-${input.requestId}`,
          output: `Local demo response: ${input.input}`,
          usage: [
            {
              resource: "ai_request" as const,
              quantity: 1,
              unit: "request" as const,
            },
            {
              resource: "ai_tokens" as const,
              quantity: 12,
              unit: "token" as const,
            },
          ],
        };
      },
    },
  };

  const archiveBytes = createStoredZip([{
    path: "modrinth.index.json",
    bytes: jsonBytes(archiveManifest()),
  }]);
  const archive = {
    sha256: await sha256Hex(archiveBytes),
    sizeBytes: archiveBytes.byteLength,
  };
  const modpackRepository = new InMemoryModpackDeploymentRepository();
  const deploymentTarget: ServerCompatibilityGateway = {
    async getDeploymentTarget(accountId, serverId) {
      if (accountId !== DEMO_ACCOUNT_ID) return undefined;
      const server = (await serverRepository.read(accountId)).servers.find(
        (item) => item.serverId === serverId,
      );
      if (!server) return undefined;
      return {
        serverId,
        accountId,
        state: server.status === "running"
          ? "running" as const
          : "stopped" as const,
        compatibility: {
          minecraftVersion: "1.21.1",
          loader: "fabric" as const,
          loaderVersion: "0.16.10",
          javaMajor: 21,
          templateId: "fabric-1.21",
        },
      };
    },
  };
  const workerStaging: WorkerDeploymentGateway = {
    async createRollbackSnapshot(input) {
      return `demo-snapshot-${input.deploymentId}`;
    },
    async stageAndVerify(input) {
      const canonical = new TextEncoder().encode(
        JSON.stringify(input.manifest),
      );
      return {
        stagingId: `demo-staging-${input.operationId}`,
        manifestSha256: await sha256Hex(canonical),
      };
    },
    async atomicSwitch() {},
    async restoreSnapshot() {},
  };
  let runDeploymentTask: (taskId: string) => Promise<void>;
  const dispatcher: ModpackDeploymentTaskDispatcher = {
    async enqueue(taskId) {
      await runDeploymentTask(taskId);
    },
  };
  const modpackRuntime = createModpackDeploymentRuntime({
    repository: modpackRepository,
    archives: {
      async createUpload(input) {
        return {
          uploadUrl: `mock://local-demo-modpack-storage/${input.importId}`,
          expiresAt: "2099-01-01T00:00:00.000Z",
          maxSizeBytes: input.expectedSizeBytes,
        };
      },
      async readVerified(_importId, expectedSha256, expectedSizeBytes) {
        if (
          expectedSha256 !== archive.sha256 ||
          expectedSizeBytes !== archive.sizeBytes
        ) {
          throw new Error("local demo archive metadata does not match");
        }
        return archiveBytes;
      },
    } as ModpackArchiveStore,
    dispatcher,
    resolvers: [{
      provider: "modrinth",
      async resolve(reference) {
        return {
          ...reference,
          sha256: "b".repeat(64),
          sizeBytes: 42,
          downloadUrl: "https://local-demo.invalid/mods/local-demo.jar",
        };
      },
    }],
    now,
    id: nextId,
  });
  const deploymentCoordinator = modpackRuntime.createCoordinator({
    serverControlTarget: deploymentTarget,
    workerStaging,
  });
  runDeploymentTask = async (taskId) => {
    await deploymentCoordinator.runTask(taskId);
  };
  const sharedModpackRuntime = {
    createCoordinator: () => deploymentCoordinator,
  };

  const adminRepository = new DemoOperations();
  const audit = new DemoAuditLog();
  const adminService = new AdminOperationService(
    adminRepository,
    audit,
    { publish: async () => {} },
    now,
  );
  const adminPrincipal = (): AdminPrincipal => ({
    id: "demo-admin",
    scopes: ["admin"],
    mfaVerifiedAt: new Date().toISOString(),
  });

  const app = createApp((shared) => {
    shared.use("*", async (context, next) => {
      // This rejected accessor prevents accidental Mongo configuration use when
      // an unsupported legacy route is requested in local demo.
      context.set(
        "getDb",
        (() =>
          Promise.reject(
            new Error(
              "Mongo-backed routes are not available in local demo",
            ),
          )) as AppEnv["Variables"]["getDb"],
      );
      context.set("accountRuntime", accountRuntime);
      context.set("billingService", billing);
      context.set("paypalService", paypal);
      context.set("usageSettlementService", usage);
      context.set("sharedHostingService", sharedHosting);
      context.set("sharedHostingScheduler", sharedHostingScheduler);
      context.set("serverControlRuntime", serverRuntime);
      context.set("workerRuntime", workerRuntime);
      context.set("worldBackupService", worldBackups);
      context.set("worldBackupRestoreWorkerAuthenticator", {
        async authenticate(input) {
          return input.authorization ===
              `Bearer ${LOCAL_DEMO_CREDENTIALS.restoreWorkerAccessToken}`
            ? {
              workerId: "demo-restore-worker",
              serverId: DEMO_SERVER_ID,
              leaseId: DEMO_LEASE_ID,
              scopes: [WORLD_BACKUP_RESTORE_WORKER_SCOPE],
            }
            : undefined;
        },
      });
      context.set("aiServiceDependencies", ai);
      context.set("modpackDeploymentRuntime", sharedModpackRuntime);
      context.set("modpackDeploymentServerControlTarget", deploymentTarget);
      context.set("modpackDeploymentWorkerStaging", workerStaging);
      context.set("adminOperationAuthenticator", {
        async authenticate(authorization) {
          return authorization ===
              `Bearer ${LOCAL_DEMO_CREDENTIALS.adminAccessToken}`
            ? adminPrincipal()
            : undefined;
        },
      });
      context.set("adminOperationService", adminService);
      context.set("adminOperationAuditEvents", async () => ({
        items: structuredClone(audit.events),
      }));
      context.set("adminOperationMetrics", {
        async read() {
          return {
            generatedAt: now(),
            metrics: [{
              name: "local_demo_requests",
              value: 0,
              unit: "count" as const,
            }],
          };
        },
      });
      context.set("adminOperationReconciliation", {
        async latest() {
          return {
            reportId: "local-demo-reconciliation",
            generatedAt: now(),
            checks: [],
          };
        },
      });
      context.set("adminOperationAccountReader", {
        async read(accountId) {
          const account = await accountRuntime.accounts.requireAccount(
            accountId,
          );
          return {
            accountId: account.accountId,
            status: account.status,
            createdAt: account.createdAt,
          };
        },
      });
      await next();
    });
  });

  app.get("/__local-demo", (context) => {
    context.header("Cache-Control", "no-store");
    return context.json({
      profile: LOCAL_DEMO_PROFILE,
      warning:
        "LOCAL DEMO ONLY. In-memory data resets whenever this process stops.",
      credentials: LOCAL_DEMO_CREDENTIALS,
      accountId: DEMO_ACCOUNT_ID,
      server: { serverId: DEMO_SERVER_ID, leaseId: DEMO_LEASE_ID },
      modpackArchive: archive,
      mockBoundaries: [
        "No real PayPal, Vultr, AI, object storage, MongoDB, or OAuth provider is used.",
        "Object-storage and modpack uploads are accepted in memory when their upload URL is issued.",
      ],
    });
  });

  return { app, archive };
}
