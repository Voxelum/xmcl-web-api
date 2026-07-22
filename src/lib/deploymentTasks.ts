// deno-lint-ignore-file require-await

import {
  createDeploymentPreview,
  type DeploymentManifest,
  type DeploymentPreview,
  freezeDeploymentManifest,
} from "./deploymentManifest.ts";
import type {
  ModpackSourceResolver,
  ResolvedModSource,
} from "./modpackSources/types.ts";
import {
  type ModpackCompatibility,
  type ModpackValidationReport,
  type ValidatedArchiveFile,
  type ValidatedModpack,
  validateModpackArchive,
} from "./modpackValidator.ts";

export interface ApiError {
  error: string;
  message: string;
  requestId: string;
  details?: unknown;
}

export interface AsyncTask<T = unknown> {
  taskId: string;
  requestId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  resource?: { type: string; id: string };
  result?: T;
  error?: ApiError;
  createdAt: string;
  updatedAt: string;
}

export interface ModpackDeploymentPrincipal {
  accountId: string;
  scopes: readonly string[];
}

export interface ModpackImportRecord {
  importId: string;
  serverId: string;
  accountId: string;
  sourceFormat: "mrpack" | "curseforge_zip";
  status: "awaiting_upload" | "uploaded" | "validating" | "valid" | "invalid";
  expectedSha256: string;
  expectedSizeBytes: number;
  validation?: ModpackValidationReport;
  createdAt: string;
  updatedAt: string;
}

export type DeploymentStatus =
  | "preparing"
  | "draft"
  | "previewing"
  | "previewed"
  | "applying"
  | "applied"
  | "apply_failed"
  | "rolling_back"
  | "rolled_back"
  | "rollback_failed";

export interface ModpackDeploymentRecord {
  deploymentId: string;
  importId: string;
  serverId: string;
  accountId: string;
  status: DeploymentStatus;
  manifest?: Readonly<DeploymentManifest>;
  manifestSha256?: string;
  preview?: DeploymentPreview;
  activeDeploymentIdBeforeApply?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ServerDeploymentTarget {
  serverId: string;
  accountId: string;
  state: "running" | "stopped";
  compatibility: ModpackCompatibility;
  activeDeploymentId?: string;
  /**
   * ModpackDeployment-local view of `contracts/shared/v1/balance-exhaustion.schema.json`.
   * Worker emits this event and ServerControl owns the resulting server state; ModpackDeployment only uses
   * it to avoid applying a deployment to a stopped runtime.
   */
  runtimeStopped?: {
    eventType: "runtime.stopped.v1";
    eventId: string;
    schemaVersion: 1;
    serverId: string;
    leaseId: string;
    settlementId: string;
    reason: "balance_exhausted";
    occurredAt: string;
  };
}

/** ModpackDeployment-local proposal for the ServerControl ownership/compatibility API. */
export interface ServerCompatibilityGateway {
  getDeploymentTarget(
    accountId: string,
    serverId: string,
  ): Promise<ServerDeploymentTarget | undefined>;
}

/** ModpackDeployment-local proposal for object storage signed uploads. */
export interface ModpackArchiveStore {
  createUpload(input: {
    importId: string;
    expectedSha256: string;
    expectedSizeBytes: number;
  }): Promise<{ uploadUrl: string; expiresAt: string; maxSizeBytes: number }>;
  readVerified(
    importId: string,
    expectedSha256: string,
    expectedSizeBytes: number,
  ): Promise<Uint8Array>;
}

/** ModpackDeployment-local proposal for Worker staging, atomic switch, and snapshot restore. */
export interface WorkerDeploymentGateway {
  createRollbackSnapshot(input: {
    deploymentId: string;
    serverId: string;
  }): Promise<string>;
  stageAndVerify(input: {
    operationId: string;
    manifest: Readonly<DeploymentManifest>;
    sources: readonly ResolvedModSource[];
    configFiles: readonly ValidatedArchiveFile[];
    dataFiles: readonly ValidatedArchiveFile[];
  }): Promise<{ stagingId: string; manifestSha256: string }>;
  atomicSwitch(input: {
    operationId: string;
    serverId: string;
    deploymentId: string;
    stagingId: string;
    manifestSha256: string;
  }): Promise<void>;
  restoreSnapshot(input: {
    operationId: string;
    serverId: string;
    snapshotId: string;
  }): Promise<void>;
}

export interface ModpackDeploymentTaskDispatcher {
  enqueue(taskId: string): Promise<void>;
}

export interface OperationClaim {
  accountId: string;
  scope: string;
  idempotencyKey: string;
  fingerprint: string;
  taskId: string;
}

export interface ModpackDeploymentRepository {
  claimOperation(
    claim: OperationClaim,
  ): Promise<"claimed" | "duplicate" | "conflict">;
  getClaim(
    accountId: string,
    scope: string,
    key: string,
  ): Promise<OperationClaim | undefined>;
  putImport(record: ModpackImportRecord): Promise<void>;
  getImport(importId: string): Promise<ModpackImportRecord | undefined>;
  putValidated(importId: string, value: ValidatedModpack): Promise<void>;
  getValidated(importId: string): Promise<ValidatedModpack | undefined>;
  putDeployment(record: ModpackDeploymentRecord): Promise<void>;
  getDeployment(
    deploymentId: string,
  ): Promise<ModpackDeploymentRecord | undefined>;
  listDeployments(serverId: string): Promise<ModpackDeploymentRecord[]>;
  transitionDeployment(
    deploymentId: string,
    expected: readonly DeploymentStatus[],
    update: (record: ModpackDeploymentRecord) => ModpackDeploymentRecord,
  ): Promise<ModpackDeploymentRecord | undefined>;
  putTask(task: AsyncTask): Promise<void>;
  getTask(taskId: string): Promise<AsyncTask | undefined>;
  createTask(task: AsyncTask, command: TaskCommand): Promise<void>;
  getTaskCommand(taskId: string): Promise<TaskCommand | undefined>;
  recordWorkerEvent(input: {
    deploymentId: string;
    eventId: string;
    sequence: number;
    fingerprint: string;
  }): Promise<"accepted" | "duplicate" | "out_of_order" | "conflict">;
}

export class ModpackDeploymentError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "forbidden"
      | "invalid_request"
      | "idempotency_conflict"
      | "state_conflict"
      | "invalid_import"
      | "incompatible_template"
      | "archive_verification_failed"
      | "worker_staging_failed"
      | "worker_hash_mismatch"
      | "rollback_snapshot_missing"
      | "server_not_ready"
      | "event_conflict"
      | "out_of_order",
    readonly details?: unknown,
  ) {
    super(code);
    this.name = "ModpackDeploymentError";
  }
}

export type TaskCommand =
  | { kind: "validate"; importId: string }
  | { kind: "prepare"; deploymentId: string }
  | { kind: "preview"; deploymentId: string }
  | { kind: "apply"; deploymentId: string }
  | { kind: "rollback"; deploymentId: string };

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function fingerprint(value: unknown) {
  return JSON.stringify(canonicalize(value));
}

function sameCompatibility(
  requested: ModpackCompatibility,
  supported: ModpackCompatibility,
) {
  return requested.minecraftVersion === supported.minecraftVersion &&
    requested.loader === supported.loader &&
    requested.loaderVersion === supported.loaderVersion &&
    requested.javaMajor === supported.javaMajor &&
    requested.templateId === supported.templateId;
}

export class ModpackDeploymentCoordinator {
  constructor(
    private readonly repository: ModpackDeploymentRepository,
    private readonly archives: ModpackArchiveStore,
    private readonly servers: ServerCompatibilityGateway,
    private readonly worker: WorkerDeploymentGateway,
    private readonly dispatcher: ModpackDeploymentTaskDispatcher,
    private readonly resolvers: readonly ModpackSourceResolver[],
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly id: (prefix: string) => string = (prefix) =>
      `${prefix}_${crypto.randomUUID()}`,
  ) {}

  async createImport(input: {
    principal: ModpackDeploymentPrincipal;
    requestId: string;
    idempotencyKey: string;
    serverId: string;
    sourceFormat: "mrpack" | "curseforge_zip";
    expectedSha256: string;
    expectedSizeBytes: number;
  }): Promise<ModpackImportRecord> {
    if (
      !/^[a-f0-9]{64}$/i.test(input.expectedSha256) ||
      !Number.isSafeInteger(input.expectedSizeBytes) ||
      input.expectedSizeBytes <= 0
    ) throw new ModpackDeploymentError("invalid_request");
    await this.requireServer(input.principal, input.serverId);
    const importId = this.id("mpi");
    const claim = await this.claim(input, `create-import:${input.serverId}`, {
      sourceFormat: input.sourceFormat,
      expectedSha256: input.expectedSha256.toLowerCase(),
      expectedSizeBytes: input.expectedSizeBytes,
    }, importId);
    if (claim.duplicate) {
      const existing = await this.repository.getImport(claim.resourceId);
      if (!existing) throw new ModpackDeploymentError("state_conflict");
      return existing;
    }
    const timestamp = this.now();
    const record: ModpackImportRecord = {
      importId,
      serverId: input.serverId,
      accountId: input.principal.accountId,
      sourceFormat: input.sourceFormat,
      status: "awaiting_upload",
      expectedSha256: input.expectedSha256.toLowerCase(),
      expectedSizeBytes: input.expectedSizeBytes,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.repository.putImport(record);
    return record;
  }

  async createUpload(input: {
    principal: ModpackDeploymentPrincipal;
    importId: string;
  }) {
    const record = await this.requireImport(input.principal, input.importId);
    if (record.status !== "awaiting_upload") {
      throw new ModpackDeploymentError("state_conflict");
    }
    return await this.archives.createUpload({
      importId: record.importId,
      expectedSha256: record.expectedSha256,
      expectedSizeBytes: record.expectedSizeBytes,
    });
  }

  async completeImport(input: OperationInput & { importId: string }) {
    const record = await this.requireImport(input.principal, input.importId);
    if (
      record.status !== "awaiting_upload" && record.status !== "uploaded" &&
      record.status !== "validating" && record.status !== "valid" &&
      record.status !== "invalid"
    ) {
      throw new ModpackDeploymentError("state_conflict");
    }
    if (record.status === "awaiting_upload") {
      record.status = "uploaded";
      record.updatedAt = this.now();
      await this.repository.putImport(record);
    }
    return await this.queue(
      input,
      `complete-import:${record.importId}`,
      {
        importId: record.importId,
      },
      { type: "modpack_import", id: record.importId },
      {
        kind: "validate",
        importId: record.importId,
      },
    );
  }

  async createDeployment(
    input: OperationInput & {
      serverId: string;
      importId: string;
    },
  ): Promise<{ deployment: ModpackDeploymentRecord; task: AsyncTask }> {
    await this.requireServer(input.principal, input.serverId);
    const imported = await this.requireImport(input.principal, input.importId);
    if (imported.serverId !== input.serverId || imported.status !== "valid") {
      throw new ModpackDeploymentError("invalid_import");
    }
    const deploymentId = this.id("mpd");
    const queued = await this.queue(
      input,
      `create-deployment:${input.serverId}`,
      { importId: input.importId },
      { type: "modpack_deployment", id: deploymentId },
      { kind: "prepare", deploymentId },
      false,
    );
    if (queued.duplicate) {
      const deployment = await this.repository.getDeployment(
        queued.task.resource!.id,
      );
      if (!deployment) throw new ModpackDeploymentError("state_conflict");
      return { deployment, task: queued.task };
    }
    const timestamp = this.now();
    const deployment: ModpackDeploymentRecord = {
      deploymentId,
      importId: input.importId,
      serverId: input.serverId,
      accountId: input.principal.accountId,
      status: "preparing",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.repository.putDeployment(deployment);
    await this.dispatcher.enqueue(queued.task.taskId);
    return { deployment, task: queued.task };
  }

  async preview(input: OperationInput & { deploymentId: string }) {
    const deployment = await this.requireDeployment(
      input.principal,
      input.deploymentId,
    );
    if (
      deployment.status !== "draft" && deployment.status !== "previewing" &&
      deployment.status !== "previewed"
    ) {
      throw new ModpackDeploymentError("state_conflict");
    }
    return await this.queue(
      input,
      `preview:${deployment.deploymentId}`,
      { manifestSha256: deployment.manifestSha256 ?? null },
      { type: "modpack_deployment", id: deployment.deploymentId },
      { kind: "preview", deploymentId: deployment.deploymentId },
    );
  }

  async apply(
    input: OperationInput & {
      deploymentId: string;
      manifestSha256: string;
    },
  ) {
    const deployment = await this.requireDeployment(
      input.principal,
      input.deploymentId,
    );
    if (
      !["previewed", "applying", "applied", "apply_failed"].includes(
        deployment.status,
      ) ||
      deployment.manifestSha256 !== input.manifestSha256
    ) throw new ModpackDeploymentError("state_conflict");
    const target = await this.requireServer(
      input.principal,
      deployment.serverId,
    );
    if (target.state !== "running") {
      throw new ModpackDeploymentError("server_not_ready", {
        serverState: target.state,
        runtimeStopped: target.runtimeStopped,
      });
    }
    return await this.queue(
      input,
      `apply:${deployment.deploymentId}`,
      { manifestSha256: input.manifestSha256 },
      { type: "modpack_deployment", id: deployment.deploymentId },
      { kind: "apply", deploymentId: deployment.deploymentId },
    );
  }

  async rollback(input: OperationInput & { deploymentId: string }) {
    const deployment = await this.requireDeployment(
      input.principal,
      input.deploymentId,
    );
    if (
      !["applied", "rolling_back", "rolled_back", "rollback_failed"].includes(
        deployment.status,
      ) || !deployment.manifest?.rollbackSnapshotId
    ) {
      throw new ModpackDeploymentError(
        deployment.manifest?.rollbackSnapshotId
          ? "state_conflict"
          : "rollback_snapshot_missing",
      );
    }
    return await this.queue(
      input,
      `rollback:${deployment.deploymentId}`,
      { snapshotId: deployment.manifest.rollbackSnapshotId },
      { type: "modpack_deployment", id: deployment.deploymentId },
      { kind: "rollback", deploymentId: deployment.deploymentId },
    );
  }

  async runTask(taskId: string): Promise<AsyncTask> {
    const task = await this.repository.getTask(taskId);
    const command = await this.repository.getTaskCommand(taskId);
    if (!task || !command) throw new ModpackDeploymentError("not_found");
    if (task.status === "succeeded" || task.status === "cancelled") return task;
    task.status = "running";
    task.error = undefined;
    task.updatedAt = this.now();
    await this.repository.putTask(task);
    try {
      const result = await this.execute(command, taskId);
      task.status = "succeeded";
      task.result = result;
      task.updatedAt = this.now();
      await this.repository.putTask(task);
    } catch (error) {
      task.status = "failed";
      task.updatedAt = this.now();
      task.error = {
        error: error instanceof ModpackDeploymentError
          ? error.code
          : "task_failed",
        message: error instanceof Error ? error.message : "task_failed",
        requestId: task.requestId,
        details: error instanceof ModpackDeploymentError
          ? error.details
          : undefined,
      };
      await this.repository.putTask(task);
    }
    return task;
  }

  async getImport(principal: ModpackDeploymentPrincipal, importId: string) {
    return await this.requireImport(principal, importId);
  }

  async getDeployment(
    principal: ModpackDeploymentPrincipal,
    deploymentId: string,
  ) {
    return await this.requireDeployment(principal, deploymentId);
  }

  async listDeployments(
    principal: ModpackDeploymentPrincipal,
    serverId: string,
  ) {
    await this.requireServer(principal, serverId);
    return (await this.repository.listDeployments(serverId)).filter((item) =>
      item.accountId === principal.accountId
    );
  }

  async getTask(principal: ModpackDeploymentPrincipal, taskId: string) {
    const task = await this.repository.getTask(taskId);
    if (!task) throw new ModpackDeploymentError("not_found");
    if (task.resource?.type === "modpack_deployment") {
      await this.requireDeployment(principal, task.resource.id);
    } else if (task.resource?.type === "modpack_import") {
      await this.requireImport(principal, task.resource.id);
    }
    return task;
  }

  async acceptWorkerEvent(input: {
    deploymentId: string;
    eventId: string;
    sequence: number;
    type:
      | "stage_verified"
      | "switch_completed"
      | "rollback_completed"
      | "failed";
    manifestSha256?: string;
  }): Promise<{ duplicate: boolean }> {
    const deployment = await this.repository.getDeployment(input.deploymentId);
    if (!deployment) throw new ModpackDeploymentError("not_found");
    const allowed: Record<typeof input.type, readonly DeploymentStatus[]> = {
      stage_verified: ["applying"],
      switch_completed: ["applying", "applied"],
      rollback_completed: ["rolling_back", "rolled_back"],
      failed: ["applying", "rolling_back"],
    };
    if (!allowed[input.type].includes(deployment.status)) {
      throw new ModpackDeploymentError("state_conflict");
    }
    if (
      input.manifestSha256 &&
      input.manifestSha256 !== deployment.manifestSha256
    ) throw new ModpackDeploymentError("worker_hash_mismatch");
    const recorded = await this.repository.recordWorkerEvent({
      deploymentId: input.deploymentId,
      eventId: input.eventId,
      sequence: input.sequence,
      fingerprint: fingerprint(input),
    });
    if (recorded === "duplicate") return { duplicate: true };
    if (recorded === "out_of_order") {
      throw new ModpackDeploymentError("out_of_order");
    }
    if (recorded === "conflict") {
      throw new ModpackDeploymentError("event_conflict");
    }
    return { duplicate: false };
  }

  private async execute(
    command: TaskCommand,
    taskId: string,
  ): Promise<unknown> {
    if (command.kind === "validate") {
      return await this.executeValidation(command.importId);
    }
    const deployment = await this.repository.getDeployment(
      command.deploymentId,
    );
    if (!deployment) throw new ModpackDeploymentError("not_found");
    if (command.kind === "prepare") {
      const validated = await this.repository.getValidated(deployment.importId);
      if (!validated || validated.report.status !== "valid") {
        throw new ModpackDeploymentError("invalid_import");
      }
      const target = await this.servers.getDeploymentTarget(
        deployment.accountId,
        deployment.serverId,
      );
      if (
        !target ||
        !validated.report.compatibility ||
        !sameCompatibility(validated.report.compatibility, target.compatibility)
      ) throw new ModpackDeploymentError("incompatible_template");
      const updated = await this.repository.transitionDeployment(
        deployment.deploymentId,
        ["preparing"],
        (current) => ({ ...current, status: "draft", updatedAt: this.now() }),
      );
      if (!updated) throw new ModpackDeploymentError("state_conflict");
      return { deploymentId: updated.deploymentId, status: updated.status };
    }
    if (command.kind === "preview") {
      const claimed = await this.repository.transitionDeployment(
        deployment.deploymentId,
        ["draft", "previewing", "previewed"],
        (current) => ({
          ...current,
          status: "previewing",
          updatedAt: this.now(),
        }),
      );
      if (!claimed) throw new ModpackDeploymentError("state_conflict");
      if (deployment.manifest && deployment.preview) {
        await this.repository.putDeployment({
          ...deployment,
          status: "previewed",
          updatedAt: this.now(),
        });
        return deployment.preview;
      }
      const validated = await this.repository.getValidated(deployment.importId);
      if (!validated?.report.compatibility) {
        throw new ModpackDeploymentError("invalid_import");
      }
      const snapshotId = await this.worker.createRollbackSnapshot({
        deploymentId: deployment.deploymentId,
        serverId: deployment.serverId,
      });
      if (!snapshotId) {
        throw new ModpackDeploymentError("rollback_snapshot_missing");
      }
      const frozen = await freezeDeploymentManifest({
        deploymentId: deployment.deploymentId,
        serverId: deployment.serverId,
        sourceFormat: validated.report.sourceFormat,
        compatibility: validated.report.compatibility,
        configFiles: validated.configFiles,
        dataFiles: validated.dataFiles,
        mods: validated.resolvedMods,
        rollbackSnapshotId: snapshotId,
        createdAt: this.now(),
      });
      const preview = createDeploymentPreview(frozen);
      await this.repository.putDeployment({
        ...deployment,
        status: "previewed",
        manifest: frozen.manifest,
        manifestSha256: frozen.manifestSha256,
        preview,
        updatedAt: this.now(),
      });
      return preview;
    }
    if (command.kind === "apply") {
      if (!deployment.manifest || !deployment.manifestSha256) {
        throw new ModpackDeploymentError("state_conflict");
      }
      const applying = await this.repository.transitionDeployment(
        deployment.deploymentId,
        ["previewed", "apply_failed"],
        (current) => ({
          ...current,
          status: "applying",
          updatedAt: this.now(),
        }),
      );
      if (!applying) throw new ModpackDeploymentError("state_conflict");
      const validated = await this.repository.getValidated(deployment.importId);
      if (!validated) throw new ModpackDeploymentError("invalid_import");
      const target = await this.servers.getDeploymentTarget(
        deployment.accountId,
        deployment.serverId,
      );
      if (!target || target.state !== "running") {
        throw new ModpackDeploymentError("server_not_ready", {
          serverState: target?.state ?? "unknown",
          runtimeStopped: target?.runtimeStopped,
        });
      }
      try {
        const staged = await this.worker.stageAndVerify({
          operationId: taskId,
          manifest: deployment.manifest,
          sources: validated.resolvedMods,
          configFiles: validated.configFiles,
          dataFiles: validated.dataFiles,
        });
        if (staged.manifestSha256 !== deployment.manifestSha256) {
          throw new ModpackDeploymentError("worker_hash_mismatch");
        }
        await this.worker.atomicSwitch({
          operationId: taskId,
          serverId: deployment.serverId,
          deploymentId: deployment.deploymentId,
          stagingId: staged.stagingId,
          manifestSha256: deployment.manifestSha256,
        });
      } catch (error) {
        await this.repository.transitionDeployment(
          deployment.deploymentId,
          ["applying"],
          (current) => ({
            ...current,
            status: "apply_failed",
            updatedAt: this.now(),
          }),
        );
        if (error instanceof ModpackDeploymentError) throw error;
        throw new ModpackDeploymentError("worker_staging_failed");
      }
      await this.repository.transitionDeployment(
        deployment.deploymentId,
        ["applying"],
        (current) => ({
          ...current,
          status: "applied",
          activeDeploymentIdBeforeApply: target?.activeDeploymentId,
          updatedAt: this.now(),
        }),
      );
      return { deploymentId: deployment.deploymentId, status: "applied" };
    }
    const rollingBack = await this.repository.transitionDeployment(
      deployment.deploymentId,
      ["applied", "rollback_failed"],
      (current) => ({
        ...current,
        status: "rolling_back",
        updatedAt: this.now(),
      }),
    );
    if (!rollingBack?.manifest?.rollbackSnapshotId) {
      throw new ModpackDeploymentError("rollback_snapshot_missing");
    }
    try {
      await this.worker.restoreSnapshot({
        operationId: taskId,
        serverId: deployment.serverId,
        snapshotId: rollingBack.manifest.rollbackSnapshotId,
      });
    } catch {
      await this.repository.transitionDeployment(
        deployment.deploymentId,
        ["rolling_back"],
        (current) => ({
          ...current,
          status: "rollback_failed",
          updatedAt: this.now(),
        }),
      );
      throw new ModpackDeploymentError("worker_staging_failed");
    }
    await this.repository.transitionDeployment(
      deployment.deploymentId,
      ["rolling_back"],
      (current) => ({
        ...current,
        status: "rolled_back",
        updatedAt: this.now(),
      }),
    );
    return { deploymentId: deployment.deploymentId, status: "rolled_back" };
  }

  private async executeValidation(importId: string) {
    const imported = await this.repository.getImport(importId);
    if (!imported) throw new ModpackDeploymentError("not_found");
    if (imported.status !== "uploaded" && imported.status !== "validating") {
      throw new ModpackDeploymentError("state_conflict");
    }
    imported.status = "validating";
    imported.updatedAt = this.now();
    await this.repository.putImport(imported);
    let archive: Uint8Array;
    try {
      archive = await this.archives.readVerified(
        importId,
        imported.expectedSha256,
        imported.expectedSizeBytes,
      );
    } catch {
      throw new ModpackDeploymentError("archive_verification_failed");
    }
    const validated = await validateModpackArchive({
      importId,
      archive,
      resolvers: this.resolvers,
    });
    await this.repository.putValidated(importId, validated);
    imported.validation = validated.report;
    imported.status = validated.report.status === "valid" ? "valid" : "invalid";
    imported.updatedAt = this.now();
    await this.repository.putImport(imported);
    return validated.report;
  }

  private async queue(
    input: OperationInput,
    scope: string,
    body: unknown,
    resource: { type: string; id: string },
    command: TaskCommand,
    dispatch = true,
  ): Promise<{ task: AsyncTask; duplicate: boolean }> {
    const taskId = this.id("task");
    const claimed = await this.claim(input, scope, body, taskId);
    if (claimed.duplicate) {
      const task = await this.repository.getTask(claimed.resourceId);
      if (!task) throw new ModpackDeploymentError("state_conflict");
      return { task, duplicate: true };
    }
    const timestamp = this.now();
    const task: AsyncTask = {
      taskId,
      requestId: input.requestId,
      status: "queued",
      resource,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.repository.createTask(task, command);
    if (dispatch) await this.dispatcher.enqueue(taskId);
    return { task, duplicate: false };
  }

  private async claim(
    input: { principal: ModpackDeploymentPrincipal; idempotencyKey: string },
    scope: string,
    body: unknown,
    resourceId: string,
  ): Promise<{ duplicate: boolean; resourceId: string }> {
    const claim: OperationClaim = {
      accountId: input.principal.accountId,
      scope,
      idempotencyKey: input.idempotencyKey,
      fingerprint: fingerprint(body),
      taskId: resourceId,
    };
    const result = await this.repository.claimOperation(claim);
    if (result === "conflict") {
      throw new ModpackDeploymentError("idempotency_conflict");
    }
    if (result === "duplicate") {
      const stored = await this.repository.getClaim(
        claim.accountId,
        scope,
        claim.idempotencyKey,
      );
      if (!stored) throw new ModpackDeploymentError("state_conflict");
      return { duplicate: true, resourceId: stored.taskId };
    }
    return { duplicate: false, resourceId };
  }

  private async requireServer(
    principal: ModpackDeploymentPrincipal,
    serverId: string,
  ) {
    const target = await this.servers.getDeploymentTarget(
      principal.accountId,
      serverId,
    );
    if (!target) throw new ModpackDeploymentError("not_found");
    if (target.accountId !== principal.accountId) {
      throw new ModpackDeploymentError("forbidden");
    }
    return target;
  }

  private async requireImport(
    principal: ModpackDeploymentPrincipal,
    importId: string,
  ) {
    const imported = await this.repository.getImport(importId);
    if (!imported) throw new ModpackDeploymentError("not_found");
    if (imported.accountId !== principal.accountId) {
      throw new ModpackDeploymentError("forbidden");
    }
    return imported;
  }

  private async requireDeployment(
    principal: ModpackDeploymentPrincipal,
    deploymentId: string,
  ) {
    const deployment = await this.repository.getDeployment(deploymentId);
    if (!deployment) throw new ModpackDeploymentError("not_found");
    if (deployment.accountId !== principal.accountId) {
      throw new ModpackDeploymentError("forbidden");
    }
    return deployment;
  }
}

interface OperationInput {
  principal: ModpackDeploymentPrincipal;
  requestId: string;
  idempotencyKey: string;
}

/** Test/local-only durable-contract mock; production must supply persistent adapters. */
export class InMemoryM9Repository implements ModpackDeploymentRepository {
  readonly imports = new Map<string, ModpackImportRecord>();
  readonly validated = new Map<string, ValidatedModpack>();
  readonly deployments = new Map<string, ModpackDeploymentRecord>();
  readonly tasks = new Map<string, AsyncTask>();
  private readonly taskCommands = new Map<string, TaskCommand>();
  private readonly claims = new Map<string, OperationClaim>();
  private readonly events = new Map<
    string,
    { fingerprint: string; sequence: number }
  >();
  private readonly lastSequence = new Map<string, number>();

  async claimOperation(claim: OperationClaim) {
    const key = `${claim.accountId}:${claim.scope}:${claim.idempotencyKey}`;
    const existing = this.claims.get(key);
    if (!existing) {
      this.claims.set(key, structuredClone(claim));
      return "claimed" as const;
    }
    return existing.fingerprint === claim.fingerprint
      ? "duplicate" as const
      : "conflict" as const;
  }
  async getClaim(accountId: string, scope: string, key: string) {
    return this.claims.get(`${accountId}:${scope}:${key}`);
  }
  async putImport(record: ModpackImportRecord) {
    this.imports.set(record.importId, structuredClone(record));
  }
  async getImport(importId: string) {
    const value = this.imports.get(importId);
    return value && structuredClone(value);
  }
  async putValidated(importId: string, value: ValidatedModpack) {
    this.validated.set(importId, value);
  }
  async getValidated(importId: string) {
    return this.validated.get(importId);
  }
  async putDeployment(record: ModpackDeploymentRecord) {
    this.deployments.set(record.deploymentId, record);
  }
  async getDeployment(deploymentId: string) {
    return this.deployments.get(deploymentId);
  }
  async listDeployments(serverId: string) {
    return [...this.deployments.values()].filter((item) =>
      item.serverId === serverId
    );
  }
  async transitionDeployment(
    deploymentId: string,
    expected: readonly DeploymentStatus[],
    update: (record: ModpackDeploymentRecord) => ModpackDeploymentRecord,
  ) {
    const current = this.deployments.get(deploymentId);
    if (!current || !expected.includes(current.status)) return undefined;
    const updated = update(current);
    this.deployments.set(deploymentId, updated);
    return updated;
  }
  async putTask(task: AsyncTask) {
    this.tasks.set(task.taskId, structuredClone(task));
  }
  async getTask(taskId: string) {
    const task = this.tasks.get(taskId);
    return task && structuredClone(task);
  }
  async createTask(task: AsyncTask, command: TaskCommand) {
    this.tasks.set(task.taskId, structuredClone(task));
    const taskId = task.taskId;
    this.taskCommands.set(taskId, structuredClone(command));
  }
  async getTaskCommand(taskId: string) {
    const command = this.taskCommands.get(taskId);
    return command && structuredClone(command);
  }
  async recordWorkerEvent(input: {
    deploymentId: string;
    eventId: string;
    sequence: number;
    fingerprint: string;
  }) {
    const key = `${input.deploymentId}:${input.eventId}`;
    const existing = this.events.get(key);
    if (existing) {
      return existing.fingerprint === input.fingerprint
        ? "duplicate" as const
        : "conflict" as const;
    }
    if (input.sequence <= (this.lastSequence.get(input.deploymentId) ?? 0)) {
      return "out_of_order" as const;
    }
    this.events.set(key, {
      sequence: input.sequence,
      fingerprint: input.fingerprint,
    });
    this.lastSequence.set(input.deploymentId, input.sequence);
    return "accepted" as const;
  }
}

/** Domain-named alias for local composition; the legacy export remains stable. */
export { InMemoryM9Repository as InMemoryModpackDeploymentRepository };
