import type { Db } from "../db.ts";
import type { SharedRuntimeContent } from "./sharedHostingScheduler.ts";
import { SharedHostingScheduler } from "./sharedHostingScheduler.ts";
import {
  type ModpackSourceFormat,
  type ModpackValidationReport,
  type ValidatedArchiveFile,
  type ValidatedModpack,
  validateModpackArchive,
} from "./modpackValidator.ts";
import type {
  ModpackSourceResolver,
  ResolvedModSource,
} from "./modpackSources/types.ts";
import { assertProviderDownloadUrl } from "./modpackSources/types.ts";
import type { SharedNodeWorkspaceSigner } from "./sharedNodeTransport.ts";
import {
  type ValidatedXmclServerBundle,
  type XmclServerBundleManifest,
  type XmclServerBundleValidationReport,
  validateXmclServerBundle,
} from "./xmclServerBundle.ts";
import {
  isReviewedRuntimeToolchain,
  runtimeCatalog,
  type RuntimeCatalogJava,
} from "./runtimeCatalog.ts";

const encoder = new TextEncoder();
const maxCompilerArtifactBytes = 4 * 1024 * 1024 * 1024;
const maxCompilerArchiveBytes = 512 * 1024 * 1024;

export type RuntimeLoaderKind = "forge" | "fabric" | "neoforge" | "quilt";

export interface RuntimeDescriptor {
  schemaVersion: 1;
  minecraftVersion: string;
  java: RuntimeCatalogJava;
  runtimeCatalog: { sha256: string };
  loader: { kind: RuntimeLoaderKind; version: string };
  launch: {
    kind: "generated-server-launcher";
    path: ".xmcl/launch.sh";
    arguments: [];
  };
  contentSha256: string;
}

export interface SharedRuntimeContentDescriptor {
  key: string;
  sha256: string;
  compressedSize: number;
  logicalSize: number;
  paths: readonly string[];
}

export interface SharedRuntimeFrozenManifest {
  schemaVersion: 1;
  serviceId: string;
  importId: string;
  sourceFormat: ModpackSourceFormat;
  archive: { key: string; sha256: string; sizeBytes: number };
  compatibility: {
    minecraftVersion: string;
    loader: RuntimeLoaderKind;
    loaderVersion: string;
    java?: RuntimeCatalogJava;
    runtimeCatalog: { sha256: string };
  };
  configFiles: Array<{ path: string; sha256: string; sizeBytes: number }>;
  dataFiles: Array<{ path: string; sha256: string; sizeBytes: number }>;
  mods: Array<{
    provider: "modrinth" | "curseforge";
    projectId: string;
    fileId: string;
    filename: string;
    sha256: string;
    sizeBytes: number;
    downloadUrl: string;
  }>;
  /**
   * Local bundles are compiler inputs, not executable runtime metadata. The
   * compiler repeats archive/path/hash verification before using this list.
   */
  bundle?: {
    schemaVersion: 1;
    files: Array<{ path: string; sha256: string; sizeBytes: number }>;
  };
}

type SharedRuntimeValidationReport =
  | ModpackValidationReport
  | XmclServerBundleValidationReport;

type SharedValidatedImport =
  | {
    sourceFormat: "mrpack" | "curseforge_zip";
    configFiles: ValidatedArchiveFile[];
    dataFiles: ValidatedArchiveFile[];
    resolvedMods: ResolvedModSource[];
  }
  | {
    sourceFormat: "xmcl_server_bundle";
    bundle: ValidatedXmclServerBundle;
  };

export interface SharedModdedImport {
  importId: string;
  serviceId: string;
  accountId: string;
  sourceFormat: ModpackSourceFormat;
  /** Immutable, service-owned input key; never browser supplied. */
  archiveKey: string;
  expectedSha256: string;
  expectedSizeBytes: number;
  status: "awaiting_upload" | "validating" | "valid" | "invalid";
  validation?: SharedRuntimeValidationReport;
  validated?: SharedValidatedImport;
  createdAt: string;
  updatedAt: string;
}

export type SharedModdedDeploymentStatus =
  | "compile_queued"
  | "compiling"
  | "compile_failed"
  | "published"
  | "awaiting_stop_sync"
  | "selected";

export interface SharedModdedDeployment {
  deploymentId: string;
  accountId: string;
  serviceId: string;
  importId: string;
  idempotencyKey: string;
  frozenManifest: Readonly<SharedRuntimeFrozenManifest>;
  manifestSha256: string;
  expectedContentKey: string;
  status: SharedModdedDeploymentStatus;
  content?: SharedRuntimeContentDescriptor;
  descriptor?: RuntimeDescriptor;
  compilerRequestId: string;
  error?:
    | "unsupported_compatibility"
    | "compiler_unavailable"
    | "compiler_failed";
  createdAt: string;
  updatedAt: string;
}

export class SharedModdedRuntimeError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "forbidden"
      | "invalid_request"
      | "idempotency_conflict"
      | "invalid_import"
      | "unsupported_compatibility"
      | "compiler_unavailable"
      | "compiler_failed"
      | "state_conflict"
      | "terms_not_accepted"
      | "content_invalid",
    readonly details?: unknown,
  ) {
    super(code);
    this.name = "SharedModdedRuntimeError";
  }
}

export interface SharedModdedArchiveStore {
  createUpload(input: {
    importId: string;
    key: string;
    sourceFormat: ModpackSourceFormat;
    expectedSha256: string;
    expectedSizeBytes: number;
  }): Promise<{
    uploadUrl: string;
    expiresAt: string;
    maxSizeBytes: number;
    headers?: Record<string, string>;
  }>;
  readVerified(input: {
    importId: string;
    key: string;
    sourceFormat: ModpackSourceFormat;
    expectedSha256: string;
    expectedSizeBytes: number;
  }): Promise<Uint8Array>;
}

export interface SharedModdedRuntimeRepository {
  claim(input: {
    accountId: string;
    scope: string;
    key: string;
    fingerprint: string;
    resourceId: string;
  }): Promise<"claimed" | "duplicate" | "conflict">;
  getClaim(
    input: Pick<Claim, "accountId" | "scope" | "key">,
  ): Promise<Claim | undefined>;
  putImport(value: SharedModdedImport): Promise<void>;
  getImport(importId: string): Promise<SharedModdedImport | undefined>;
  putDeployment(value: SharedModdedDeployment): Promise<void>;
  getDeployment(
    deploymentId: string,
  ): Promise<SharedModdedDeployment | undefined>;
  listDeployments(serviceId: string): Promise<SharedModdedDeployment[]>;
  updateDeployment(
    deploymentId: string,
    expected: readonly SharedModdedDeploymentStatus[],
    update: (value: SharedModdedDeployment) => SharedModdedDeployment,
  ): Promise<SharedModdedDeployment | undefined>;
}

interface Claim {
  accountId: string;
  scope: string;
  key: string;
  fingerprint: string;
  resourceId: string;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemorySharedModdedRuntimeRepository
  implements SharedModdedRuntimeRepository {
  private readonly imports = new Map<string, SharedModdedImport>();
  private readonly deployments = new Map<string, SharedModdedDeployment>();
  private readonly claims = new Map<string, Claim>();
  private tail: Promise<void> = Promise.resolve();

  async claim(input: Claim) {
    return await this.transact(() => {
      const key = claimKey(input);
      const existing = this.claims.get(key);
      if (!existing) {
        this.claims.set(key, clone(input));
        return "claimed" as const;
      }
      return existing.fingerprint === input.fingerprint
        ? "duplicate" as const
        : "conflict" as const;
    });
  }

  async getClaim(input: Pick<Claim, "accountId" | "scope" | "key">) {
    await this.tail;
    const value = this.claims.get(claimKey(input));
    return value && clone(value);
  }

  async putImport(value: SharedModdedImport) {
    await this.transact(() => this.imports.set(value.importId, clone(value)));
  }

  async getImport(importId: string) {
    await this.tail;
    const value = this.imports.get(importId);
    return value && clone(value);
  }

  async putDeployment(value: SharedModdedDeployment) {
    await this.transact(() =>
      this.deployments.set(value.deploymentId, clone(value))
    );
  }

  async getDeployment(deploymentId: string) {
    await this.tail;
    const value = this.deployments.get(deploymentId);
    return value && clone(value);
  }

  async listDeployments(serviceId: string) {
    await this.tail;
    return [...this.deployments.values()]
      .filter((value) => value.serviceId === serviceId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(clone);
  }

  async updateDeployment(
    deploymentId: string,
    expected: readonly SharedModdedDeploymentStatus[],
    update: (value: SharedModdedDeployment) => SharedModdedDeployment,
  ) {
    return await this.transact(() => {
      const current = this.deployments.get(deploymentId);
      if (!current || !expected.includes(current.status)) return undefined;
      const next = clone(update(clone(current)));
      this.deployments.set(deploymentId, next);
      return clone(next);
    });
  }

  private async transact<T>(mutation: () => T) {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => release = resolve);
    await previous;
    try {
      return mutation();
    } finally {
      release();
    }
  }
}

/**
 * Durable records intentionally live outside the scheduler aggregate so
 * compiler retries cannot rewrite service/world state.
 */
export class MongoSharedModdedRuntimeRepository
  implements SharedModdedRuntimeRepository {
  constructor(private readonly db: Db) {}

  async claim(input: Claim) {
    const key = claimKey(input);
    await this.claims().updateOne(
      { _id: key },
      { $setOnInsert: { ...clone(input), _id: key } },
      { upsert: true },
    );
    const claim = await this.claims().findOne({ _id: key }) as
      | Claim
      | undefined;
    return claim?.fingerprint === input.fingerprint
      ? claim.resourceId === input.resourceId ? "claimed" : "duplicate"
      : "conflict";
  }

  async getClaim(input: Pick<Claim, "accountId" | "scope" | "key">) {
    const value = await this.claims().findOne({ _id: claimKey(input) }) as
      | Claim
      | undefined;
    return value && clone(value);
  }

  async putImport(value: SharedModdedImport) {
    await this.imports().updateOne(
      { _id: value.importId },
      { $set: { ...clone(value), _id: value.importId } },
      { upsert: true },
    );
  }

  async getImport(importId: string) {
    const value = await this.imports().findOne({ _id: importId }) as
      | SharedModdedImport
      | undefined;
    return value && clone(value);
  }

  async putDeployment(value: SharedModdedDeployment) {
    await this.deployments().updateOne(
      { _id: value.deploymentId },
      { $set: { ...clone(value), _id: value.deploymentId } },
      { upsert: true },
    );
  }

  async getDeployment(deploymentId: string) {
    const value = await this.deployments().findOne({ _id: deploymentId }) as
      | SharedModdedDeployment
      | undefined;
    return value && clone(value);
  }

  async listDeployments(serviceId: string) {
    const collection = this.deployments() as unknown as {
      find(filter: Record<string, unknown>): {
        toArray(): Promise<SharedModdedDeployment[]>;
      };
    };
    const values = await collection.find({ serviceId }).toArray();
    return values.sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt)
    ).map(clone);
  }

  async updateDeployment(
    deploymentId: string,
    expected: readonly SharedModdedDeploymentStatus[],
    update: (value: SharedModdedDeployment) => SharedModdedDeployment,
  ) {
    const current = await this.getDeployment(deploymentId);
    if (!current || !expected.includes(current.status)) return undefined;
    const next = update(clone(current));
    const result = await this.deployments().replaceOne(
      { _id: deploymentId, status: { $in: expected } },
      { ...clone(next), _id: deploymentId } as unknown as Record<
        string,
        unknown
      >,
    ) as { modifiedCount?: number };
    return result.modifiedCount === 1 ? clone(next) : undefined;
  }

  private imports() {
    return this.db.collection("shared_modded_runtime_imports");
  }
  private deployments() {
    return this.db.collection("shared_modded_runtime_deployments");
  }
  private claims() {
    return this.db.collection("shared_modded_runtime_claims");
  }
}

export interface CompilerGrant {
  key: string;
  method: "GET" | "PUT";
  url: string;
  expiresAt: string;
  headers?: Record<string, string>;
}

export interface CompilerGrantSet {
  compilerRequestId: string;
  accountId: string;
  serviceId: string;
  deploymentId: string;
  manifestSha256: string;
  grants: readonly CompilerGrant[];
}

/**
 * This authority is intentionally separate from shared-node workspace grants.
 * It can sign only the frozen import object and the one immutable compiler
 * output object; it has no list/delete/world/node capability.
 */
export class CompilerGrantAuthority {
  constructor(
    private readonly signer: SharedNodeWorkspaceSigner,
    private readonly expiresInSeconds = 10 * 60,
  ) {}

  async issue(deployment: SharedModdedDeployment): Promise<CompilerGrantSet> {
    if (
      deployment.status !== "compiling" &&
      deployment.status !== "compile_queued"
    ) {
      throw new SharedModdedRuntimeError("state_conflict");
    }
    const input = await this.sign(
      deployment.frozenManifest.archive.key,
      "GET",
    );
    const output = await this.sign(deployment.expectedContentKey, "PUT");
    return {
      compilerRequestId: deployment.compilerRequestId,
      accountId: deployment.accountId,
      serviceId: deployment.serviceId,
      deploymentId: deployment.deploymentId,
      manifestSha256: deployment.manifestSha256,
      grants: [input, output],
    };
  }

  private async sign(
    key: string,
    method: "GET" | "PUT",
  ): Promise<CompilerGrant> {
    const signed = await this.signer.presign(
      key,
      method,
      this.expiresInSeconds,
    );
    if (signed.key !== key || signed.method !== method) {
      throw new SharedModdedRuntimeError("compiler_unavailable");
    }
    if (
      method === "PUT" &&
      (Object.keys(signed.headers ?? {}).length !== 1 ||
        signed.headers?.["if-none-match"] !== "*")
    ) {
      throw new SharedModdedRuntimeError("compiler_unavailable");
    }
    return {
      key: signed.key,
      method: signed.method,
      url: signed.url,
      expiresAt: signed.expiresAt,
      ...(signed.headers ? { headers: signed.headers } : {}),
    };
  }
}

export interface SharedModdedCompiler {
  submit(input: {
    deploymentId: string;
    compilerRequestId: string;
    accountId: string;
    serviceId: string;
    frozenManifest: Readonly<SharedRuntimeFrozenManifest>;
    manifestSha256: string;
    expectedContentKey: string;
  }): Promise<void>;
}

/** Deliberately fails closed until an egress-isolated compiler is deployed. */
export class UnconfiguredSharedModdedCompiler implements SharedModdedCompiler {
  async submit(): Promise<void> {
    throw new SharedModdedRuntimeError("compiler_unavailable");
  }
}

export interface SharedModdedRuntimeOptions {
  repository: SharedModdedRuntimeRepository;
  archives: SharedModdedArchiveStore;
  resolvers: readonly ModpackSourceResolver[];
  compiler: SharedModdedCompiler;
  scheduler: SharedHostingScheduler;
  /** The only authority permitted to approve eulaAccepted on a node command. */
  terms: SharedRuntimeTerms;
  now?: () => string;
  createId?: (prefix: string) => string;
}

export interface SharedRuntimeTerms {
  accepted(input: { accountId: string; serviceId: string }): Promise<boolean>;
}

/**
 * The external terms-acceptance flow writes this narrow, versioned record.
 * Compiler callbacks and customer input can never set its acceptance bit.
 */
export class MongoSharedRuntimeTerms implements SharedRuntimeTerms {
  constructor(
    private readonly db: Db,
    private readonly termsVersion: string,
  ) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(termsVersion)
    ) {
      throw new Error("invalid shared runtime terms version");
    }
  }

  async accepted(input: { accountId: string; serviceId: string }) {
    const value = await this.db.collection("shared_runtime_terms_acceptances")
      .findOne({
        _id: `${input.accountId}:${input.serviceId}:${this.termsVersion}`,
        accountId: input.accountId,
        serviceId: input.serviceId,
        termsVersion: this.termsVersion,
        accepted: true,
      }) as { acceptedAt?: unknown } | undefined;
    return typeof value?.acceptedAt === "string" &&
      Number.isFinite(Date.parse(value.acceptedAt));
  }
}

export class SharedModdedRuntimeService {
  private readonly now: () => string;
  private readonly createId: (prefix: string) => string;

  constructor(private readonly options: SharedModdedRuntimeOptions) {
    if (
      !options.repository || !options.archives || !options.compiler ||
      !options.scheduler || !options.terms ||
      typeof options.terms.accepted !== "function"
    ) {
      throw new Error(
        "shared modded runtime composition requires durable repository, archive store, compiler, scheduler, and terms policy",
      );
    }
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ??
      ((prefix) => `${prefix}_${crypto.randomUUID()}`);
  }

  async createImport(input: {
    accountId: string;
    serviceId: string;
    sourceFormat: ModpackSourceFormat;
    expectedSha256: string;
    expectedSizeBytes: number;
    idempotencyKey: string;
  }) {
    await this.requireService(input.accountId, input.serviceId);
    validateImportInput(input);
    const importId = this.createId("shared_mpi");
    const claim = await this.options.repository.claim({
      accountId: input.accountId,
      scope: `shared-import:${input.serviceId}`,
      key: input.idempotencyKey,
      fingerprint: canonicalJson({
        sourceFormat: input.sourceFormat,
        expectedSha256: input.expectedSha256.toLowerCase(),
        expectedSizeBytes: input.expectedSizeBytes,
      }),
      resourceId: importId,
    });
    if (claim === "conflict") {
      throw new SharedModdedRuntimeError("idempotency_conflict");
    }
    if (claim === "duplicate") {
      const prior = await this.options.repository.getClaim({
        accountId: input.accountId,
        scope: `shared-import:${input.serviceId}`,
        key: input.idempotencyKey,
      });
      const existing = prior &&
        await this.options.repository.getImport(prior.resourceId);
      if (!existing || existing.accountId !== input.accountId) {
        throw new SharedModdedRuntimeError("state_conflict");
      }
      return existing;
    }
    const timestamp = this.now();
    const record: SharedModdedImport = {
      importId,
      serviceId: input.serviceId,
      accountId: input.accountId,
      sourceFormat: input.sourceFormat,
      archiveKey: compilerInputKey(
        input.accountId,
        input.serviceId,
        importId,
        input.sourceFormat,
      ),
      expectedSha256: input.expectedSha256.toLowerCase(),
      expectedSizeBytes: input.expectedSizeBytes,
      status: "awaiting_upload",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.options.repository.putImport(record);
    return record;
  }

  async uploadUrl(accountId: string, importId: string) {
    const imported = await this.requireImport(accountId, importId);
    if (imported.status !== "awaiting_upload") {
      throw new SharedModdedRuntimeError("state_conflict");
    }
    return await this.options.archives.createUpload({
      importId,
      key: imported.archiveKey,
      sourceFormat: imported.sourceFormat,
      expectedSha256: imported.expectedSha256,
      expectedSizeBytes: imported.expectedSizeBytes,
    });
  }

  async completeImport(accountId: string, importId: string) {
    const imported = await this.requireImport(accountId, importId);
    if (!["awaiting_upload", "validating"].includes(imported.status)) {
      throw new SharedModdedRuntimeError("state_conflict");
    }
    imported.status = "validating";
    imported.updatedAt = this.now();
    await this.options.repository.putImport(imported);
    let validated: ValidatedModpack | ValidatedXmclServerBundle;
    try {
      const archive = await this.options.archives.readVerified({
        importId,
        key: imported.archiveKey,
        sourceFormat: imported.sourceFormat,
        expectedSha256: imported.expectedSha256,
        expectedSizeBytes: imported.expectedSizeBytes,
      });
      validated = imported.sourceFormat === "xmcl_server_bundle"
        ? await validateXmclServerBundle({ importId, archive })
        : await validateModpackArchive({
          importId,
          archive,
          resolvers: this.options.resolvers,
        });
    } catch {
      imported.status = "invalid";
      imported.validation = invalidValidation(imported);
      imported.updatedAt = this.now();
      await this.options.repository.putImport(imported);
      return imported;
    }
    imported.validation = validated.report;
    imported.status = validated.report.status === "valid" ? "valid" : "invalid";
    if (imported.status === "valid") {
      imported.validated = imported.sourceFormat === "xmcl_server_bundle"
        ? { sourceFormat: "xmcl_server_bundle", bundle: validated as ValidatedXmclServerBundle }
        : {
          sourceFormat: imported.sourceFormat,
          configFiles: (validated as ValidatedModpack).configFiles,
          dataFiles: (validated as ValidatedModpack).dataFiles,
          resolvedMods: (validated as ValidatedModpack).resolvedMods,
        };
    }
    imported.updatedAt = this.now();
    await this.options.repository.putImport(imported);
    return imported;
  }

  async createDeployment(input: {
    accountId: string;
    serviceId: string;
    importId: string;
    idempotencyKey: string;
  }) {
    await this.requireService(input.accountId, input.serviceId);
    const imported = await this.requireImport(input.accountId, input.importId);
    if (
      imported.serviceId !== input.serviceId || imported.status !== "valid" ||
      !imported.validated || !imported.validation?.compatibility
    ) {
      throw new SharedModdedRuntimeError("invalid_import");
    }
    let frozenManifest: SharedRuntimeFrozenManifest;
    try {
      frozenManifest = await freezeRuntimeManifest(imported);
    } catch (error) {
      const reason = error instanceof SharedModdedRuntimeError
        ? error.code
        : "unsupported_compatibility";
      throw new SharedModdedRuntimeError(
        reason === "unsupported_compatibility" ? reason : "invalid_import",
      );
    }
    const manifestSha256 = await sha256(canonicalJson(frozenManifest));
    const deploymentId = this.createId("shared_mpd");
    const claim = await this.options.repository.claim({
      accountId: input.accountId,
      scope: `shared-deployment:${input.serviceId}`,
      key: input.idempotencyKey,
      fingerprint: canonicalJson({ importId: input.importId }),
      resourceId: deploymentId,
    });
    if (claim !== "claimed") {
      if (claim === "conflict") {
        throw new SharedModdedRuntimeError("idempotency_conflict");
      }
      const prior = await this.options.repository.getClaim({
        accountId: input.accountId,
        scope: `shared-deployment:${input.serviceId}`,
        key: input.idempotencyKey,
      });
      const existing = prior &&
        await this.options.repository.getDeployment(prior.resourceId);
      if (!existing || existing.accountId !== input.accountId) {
        throw new SharedModdedRuntimeError("state_conflict");
      }
      return existing;
    }
    const timestamp = this.now();
    const deployment: SharedModdedDeployment = {
      deploymentId,
      accountId: input.accountId,
      serviceId: input.serviceId,
      importId: input.importId,
      idempotencyKey: input.idempotencyKey,
      frozenManifest: deepFreeze(frozenManifest),
      manifestSha256,
      expectedContentKey: compilerContentKey(
        input.accountId,
        input.serviceId,
        manifestSha256,
      ),
      status: "compile_queued",
      compilerRequestId: `shared-compile-${deploymentId}`,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.options.repository.putDeployment(deployment);
    const compiling = await this.options.repository.updateDeployment(
      deploymentId,
      ["compile_queued"],
      (value) => ({ ...value, status: "compiling", updatedAt: this.now() }),
    );
    try {
      await this.options.compiler.submit({
        deploymentId,
        compilerRequestId: deployment.compilerRequestId,
        accountId: deployment.accountId,
        serviceId: deployment.serviceId,
        frozenManifest: deployment.frozenManifest,
        manifestSha256,
        expectedContentKey: deployment.expectedContentKey,
      });
      return await this.options.repository.getDeployment(deploymentId) ??
        compiling ?? deployment;
    } catch (error) {
      const failed = await this.options.repository.updateDeployment(
        deploymentId,
        ["compiling"],
        (value) => ({
          ...value,
          status: "compile_failed",
          error: error instanceof SharedModdedRuntimeError &&
              error.code === "compiler_unavailable"
            ? "compiler_unavailable"
            : "compiler_failed",
          updatedAt: this.now(),
        }),
      );
      return await this.options.repository.getDeployment(deploymentId) ??
        failed ?? deployment;
    }
  }

  async compilerGrants(input: {
    deploymentId: string;
    compilerRequestId: string;
    authority: CompilerGrantAuthority;
  }) {
    const deployment = await this.requireDeployment(input.deploymentId);
    if (deployment.compilerRequestId !== input.compilerRequestId) {
      throw new SharedModdedRuntimeError("state_conflict");
    }
    return await input.authority.issue(deployment);
  }

  /**
   * Structural implementation of SharedRuntimeContentGrantAuthority. The node
   * cannot obtain a compiler-content GET merely by inventing a key: the exact
   * published deployment must still be selected by this service.
   */
  async authorizeNodeRestore(input: {
    accountId: string;
    serviceId: string;
    deploymentId: string;
    manifestSha256: string;
    content: SharedRuntimeContentDescriptor;
  }) {
    const deployment = await this.options.repository.getDeployment(
      input.deploymentId,
    );
    if (
      !deployment || !["published", "selected"].includes(deployment.status) ||
      deployment.accountId !== input.accountId ||
      deployment.serviceId !== input.serviceId ||
      deployment.manifestSha256 !== input.manifestSha256 ||
      !deployment.content ||
      canonicalJson(deployment.content) !== canonicalJson(input.content)
    ) return false;
    try {
      const service = await this.options.scheduler.getService(
        input.accountId,
        input.serviceId,
      );
      return service.runtimeContent?.deploymentId === deployment.deploymentId &&
        service.runtimeContent.sha256 === deployment.content.sha256 &&
        service.runtimeContent.key === deployment.content.key;
    } catch {
      return false;
    }
  }

  /**
   * Called only by an authenticated compiler callback after it has verified the
   * immutable PUT. A failed callback cannot change the selected runtime.
   */
  async publishCompilerResult(input: {
    deploymentId: string;
    compilerRequestId: string;
    manifestSha256: string;
    content: SharedRuntimeContentDescriptor;
    descriptor: RuntimeDescriptor;
  }) {
    const current = await this.requireDeployment(input.deploymentId);
    if (
      current.compilerRequestId !== input.compilerRequestId ||
      current.manifestSha256 !== input.manifestSha256 ||
      current.expectedContentKey !== input.content.key
    ) {
      throw new SharedModdedRuntimeError("state_conflict");
    }
    validateCompiledContent(input.content, input.descriptor, current);
    if (current.status === "published") {
      if (
        current.content && current.descriptor &&
        canonicalJson(current.content) === canonicalJson(input.content) &&
        canonicalJson(current.descriptor) === canonicalJson(
          validateRuntimeDescriptor(input.descriptor),
        )
      ) return current;
      throw new SharedModdedRuntimeError("state_conflict");
    }
    if (
      current.status !== "compiling" ||
      current.manifestSha256 !== input.manifestSha256
    ) {
      throw new SharedModdedRuntimeError("state_conflict");
    }
    const published = await this.options.repository.updateDeployment(
      current.deploymentId,
      ["compiling"],
      (value) => ({
        ...value,
        status: "published",
        content: clone(input.content),
        descriptor: clone(input.descriptor),
        updatedAt: this.now(),
      }),
    );
    if (!published) {
      const raced = await this.requireDeployment(input.deploymentId);
      if (
        raced.status === "published" &&
        raced.compilerRequestId === input.compilerRequestId &&
        raced.content && raced.descriptor &&
        canonicalJson(raced.content) === canonicalJson(input.content) &&
        canonicalJson(raced.descriptor) === canonicalJson(
          validateRuntimeDescriptor(input.descriptor),
        )
      ) return raced;
      throw new SharedModdedRuntimeError("state_conflict");
    }
    return published;
  }

  /**
   * A compiler failure is durable diagnostic state only. It deliberately never
   * changes the service's selected immutable content or world revision.
   */
  async reportCompilerFailure(input: {
    deploymentId: string;
    compilerRequestId: string;
    manifestSha256: string;
    code: "unsupported_compatibility" | "compiler_unavailable" | "compiler_failed";
  }) {
    const current = await this.requireDeployment(input.deploymentId);
    if (
      current.compilerRequestId !== input.compilerRequestId ||
      current.manifestSha256 !== input.manifestSha256
    ) {
      throw new SharedModdedRuntimeError("state_conflict");
    }
    if (current.status === "compile_failed") {
      if (current.error === input.code) return current;
      throw new SharedModdedRuntimeError("state_conflict");
    }
    if (current.status !== "compiling") {
      throw new SharedModdedRuntimeError("state_conflict");
    }
    const failed = await this.options.repository.updateDeployment(
      current.deploymentId,
      ["compiling"],
      (value) => ({
        ...value,
        status: "compile_failed",
        error: input.code,
        updatedAt: this.now(),
      }),
    );
    if (!failed) {
      const raced = await this.requireDeployment(input.deploymentId);
      if (
        raced.status === "compile_failed" &&
        raced.compilerRequestId === input.compilerRequestId &&
        raced.error === input.code
      ) return raced;
      throw new SharedModdedRuntimeError("state_conflict");
    }
    return failed;
  }

  async apply(accountId: string, deploymentId: string, idempotencyKey: string) {
    const deployment = await this.requireDeployment(deploymentId);
    if (deployment.accountId !== accountId) {
      throw new SharedModdedRuntimeError("not_found");
    }
    if (
      deployment.status !== "published" &&
      deployment.status !== "awaiting_stop_sync"
    ) {
      throw new SharedModdedRuntimeError("state_conflict");
    }
    return await this.selectWhenSafe(deployment, idempotencyKey);
  }

  /**
   * A durable worker can invoke this after stop/sync reports. It performs no
   * world restore and only switches the immutable content pointer while ready.
   */
  async advance(accountId: string, deploymentId: string) {
    const deployment = await this.requireDeployment(deploymentId);
    if (
      deployment.accountId !== accountId ||
      deployment.status !== "awaiting_stop_sync"
    ) {
      throw new SharedModdedRuntimeError("state_conflict");
    }
    return await this.selectWhenSafe(deployment, `advance:${deploymentId}`);
  }

  async rollback(input: {
    accountId: string;
    serviceId: string;
    deploymentId: string;
    idempotencyKey: string;
  }) {
    const deployment = await this.requireDeployment(input.deploymentId);
    if (
      deployment.accountId !== input.accountId ||
      deployment.serviceId !== input.serviceId ||
      !["published", "selected"].includes(deployment.status)
    ) {
      throw new SharedModdedRuntimeError("not_found");
    }
    return await this.selectWhenSafe(
      deployment,
      `rollback:${input.idempotencyKey}`,
    );
  }

  async getImport(accountId: string, importId: string) {
    return await this.requireImport(accountId, importId);
  }

  async getDeployment(accountId: string, deploymentId: string) {
    const deployment = await this.requireDeployment(deploymentId);
    if (deployment.accountId !== accountId) {
      throw new SharedModdedRuntimeError("not_found");
    }
    return deployment;
  }

  async listDeployments(accountId: string, serviceId: string) {
    await this.requireService(accountId, serviceId);
    return await this.options.repository.listDeployments(serviceId);
  }

  private async selectWhenSafe(
    deployment: SharedModdedDeployment,
    idempotencyKey: string,
  ) {
    if (
      !await this.options.terms.accepted({
        accountId: deployment.accountId,
        serviceId: deployment.serviceId,
      })
    ) {
      throw new SharedModdedRuntimeError("terms_not_accepted");
    }
    const service = await this.options.scheduler.getService(
      deployment.accountId,
      deployment.serviceId,
    );
    if (service.status === "ready") {
      const content = runtimeContentFor(deployment);
      await this.options.scheduler.selectRuntimeContent({
        accountId: deployment.accountId,
        serviceId: deployment.serviceId,
        content,
        idempotencyKey,
      });
      const selected = await this.options.repository.updateDeployment(
        deployment.deploymentId,
        ["published", "awaiting_stop_sync", "selected"],
        (value) => ({ ...value, status: "selected", updatedAt: this.now() }),
      );
      return selected ?? await this.requireDeployment(deployment.deploymentId);
    }
    if (service.status === "running" || service.status === "starting") {
      await this.options.scheduler.stop(
        deployment.accountId,
        deployment.serviceId,
        `runtime-content:${deployment.deploymentId}`,
      );
      const pending = await this.options.repository.updateDeployment(
        deployment.deploymentId,
        ["published", "awaiting_stop_sync", "selected"],
        (value) => ({
          ...value,
          status: "awaiting_stop_sync",
          updatedAt: this.now(),
        }),
      );
      return pending ?? await this.requireDeployment(deployment.deploymentId);
    }
    throw new SharedModdedRuntimeError("state_conflict");
  }

  private async requireService(accountId: string, serviceId: string) {
    try {
      return await this.options.scheduler.getService(accountId, serviceId);
    } catch {
      throw new SharedModdedRuntimeError("not_found");
    }
  }

  private async requireImport(accountId: string, importId: string) {
    const imported = await this.options.repository.getImport(importId);
    if (!imported || imported.accountId !== accountId) {
      throw new SharedModdedRuntimeError("not_found");
    }
    return imported;
  }

  private async requireDeployment(deploymentId: string) {
    const deployment = await this.options.repository.getDeployment(
      deploymentId,
    );
    if (!deployment) throw new SharedModdedRuntimeError("not_found");
    return deployment;
  }
}

export function resolveRuntimeCompatibility(input: {
  minecraftVersion: string;
  loader: string;
  loaderVersion?: string;
}): { loader: RuntimeLoaderKind } {
  const loader = input.loader.toLowerCase();
  if (
    !["forge", "fabric", "neoforge", "quilt"].includes(loader) ||
    !input.loaderVersion || !validLoaderVersion(input.loaderVersion)
  ) {
    throw new SharedModdedRuntimeError("unsupported_compatibility");
  }
  const version = parseMinecraftVersion(input.minecraftVersion);
  if (!version) throw new SharedModdedRuntimeError("unsupported_compatibility");
  // NeoForge starts at Minecraft 1.20.2. Reject an invented older mapping
  // rather than silently treating it as Forge.
  if (
    loader === "neoforge" &&
    version.major === 1 && (version.minor < 20 ||
      (version.minor === 20 && version.patch < 2))
  ) {
    throw new SharedModdedRuntimeError("unsupported_compatibility");
  }
  return { loader: loader as RuntimeLoaderKind };
}

export function resolveRuntimeJava(input: {
  minecraftVersion: string;
  loader: string;
  loaderVersion?: string;
  java: RuntimeCatalogJava;
  runtimeCatalogSha256: string;
}): { loader: RuntimeLoaderKind; java: RuntimeCatalogJava } {
  const compatibility = resolveRuntimeCompatibility(input);
  if (
    input.runtimeCatalogSha256 !== runtimeCatalog.sha256 ||
    !isReviewedRuntimeToolchain({
      minecraftVersion: input.minecraftVersion,
      loader: { kind: input.loader.toLowerCase(), version: input.loaderVersion! },
      java: input.java,
    })
  ) {
    throw new SharedModdedRuntimeError("unsupported_compatibility");
  }
  return { ...compatibility, java: input.java };
}

export function validateRuntimeDescriptor(value: unknown): RuntimeDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SharedModdedRuntimeError("content_invalid");
  }
  const descriptor = value as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion",
    "minecraftVersion",
    "java",
    "runtimeCatalog",
    "loader",
    "launch",
    "contentSha256",
  ]);
  if (
    Object.keys(descriptor).some((key) => !allowed.has(key)) ||
    descriptor.schemaVersion !== 1 ||
    typeof descriptor.minecraftVersion !== "string" ||
    !parseMinecraftVersion(descriptor.minecraftVersion) ||
    !validSha256(descriptor.contentSha256)
  ) {
    throw new SharedModdedRuntimeError("content_invalid");
  }
  const loader = descriptor.loader;
  const launch = descriptor.launch;
  const java = descriptor.java;
  const descriptorCatalog = descriptor.runtimeCatalog;
  if (
    !loader || typeof loader !== "object" || Array.isArray(loader) ||
    !launch || typeof launch !== "object" || Array.isArray(launch) ||
    !java || typeof java !== "object" || Array.isArray(java) ||
    !descriptorCatalog || typeof descriptorCatalog !== "object" ||
      Array.isArray(descriptorCatalog)
  ) {
    throw new SharedModdedRuntimeError("content_invalid");
  }
  const loaderRecord = loader as Record<string, unknown>;
  const launchRecord = launch as Record<string, unknown>;
  const javaRecord = java as Record<string, unknown>;
  const catalogRecord = descriptorCatalog as Record<string, unknown>;
  if (
    Object.keys(loaderRecord).some((key) =>
      key !== "kind" && key !== "version"
    ) ||
    !["forge", "fabric", "neoforge", "quilt"].includes(
      loaderRecord.kind as string,
    ) ||
    typeof loaderRecord.version !== "string" ||
    !validLoaderVersion(loaderRecord.version) ||
    Object.keys(launchRecord).some((key) =>
      key !== "kind" && key !== "path" && key !== "arguments"
    ) ||
    launchRecord.kind !== "generated-server-launcher" ||
    launchRecord.path !== ".xmcl/launch.sh" ||
    !Array.isArray(launchRecord.arguments) ||
    launchRecord.arguments.length !== 0 ||
    Object.keys(javaRecord).some((key) => key !== "component" && key !== "major") ||
    typeof javaRecord.component !== "string" ||
    !Number.isSafeInteger(javaRecord.major) ||
    Object.keys(catalogRecord).some((key) => key !== "sha256") ||
    typeof catalogRecord.sha256 !== "string"
  ) {
    throw new SharedModdedRuntimeError("content_invalid");
  }
  const compatibility = resolveRuntimeJava({
    minecraftVersion: descriptor.minecraftVersion,
    loader: loaderRecord.kind as string,
    loaderVersion: loaderRecord.version,
    java: {
      component: javaRecord.component as string,
      major: javaRecord.major as number,
    },
    runtimeCatalogSha256: catalogRecord.sha256,
  });
  return {
    schemaVersion: 1,
    minecraftVersion: descriptor.minecraftVersion,
    java: compatibility.java,
    runtimeCatalog: { sha256: catalogRecord.sha256 },
    loader: {
      kind: loaderRecord.kind as RuntimeLoaderKind,
      version: loaderRecord.version,
    },
    launch: {
      kind: "generated-server-launcher",
      path: ".xmcl/launch.sh",
      arguments: [],
    },
    contentSha256: descriptor.contentSha256 as string,
  };
}

async function freezeRuntimeManifest(
  imported: SharedModdedImport,
): Promise<SharedRuntimeFrozenManifest> {
  if (imported.sourceFormat === "xmcl_server_bundle") {
    const validated = imported.validated;
    if (
      !validated ||
      validated.sourceFormat !== "xmcl_server_bundle" ||
      !validated.bundle.manifest
    ) {
      throw new SharedModdedRuntimeError("invalid_import");
    }
    const manifest = validated.bundle.manifest;
    const resolved = resolveRuntimeJava({
      minecraftVersion: manifest.minecraftVersion,
      loader: manifest.loader.kind,
      loaderVersion: manifest.loader.version,
      java: manifest.javaRequirement,
      runtimeCatalogSha256: manifest.runtimeCatalog.sha256,
    });
    return {
      schemaVersion: 1,
      serviceId: imported.serviceId,
      importId: imported.importId,
      sourceFormat: imported.sourceFormat,
      archive: {
        key: imported.archiveKey,
        sha256: imported.expectedSha256,
        sizeBytes: imported.expectedSizeBytes,
      },
      compatibility: {
        minecraftVersion: manifest.minecraftVersion,
        loader: resolved.loader,
        loaderVersion: manifest.loader.version,
        java: resolved.java,
        runtimeCatalog: { sha256: manifest.runtimeCatalog.sha256 },
      },
      configFiles: validated.bundle.configFiles.map((file) => ({ ...file })).sort(sortPath),
      dataFiles: validated.bundle.dataFiles.map((file) => ({ ...file })).sort(sortPath),
      mods: [],
      bundle: {
        schemaVersion: 1,
        files: validated.bundle.files.map((file) => ({ ...file })).sort(sortPath),
      },
    };
  }
  const compatibility = imported.validation!.compatibility!;
  const resolved = resolveRuntimeCompatibility({
    minecraftVersion: compatibility.minecraftVersion,
    loader: compatibility.loader,
    loaderVersion: compatibility.loaderVersion,
  });
  const validated = imported.validated;
  if (!validated || validated.sourceFormat === "xmcl_server_bundle") {
    throw new SharedModdedRuntimeError("invalid_import");
  }
  const mods = validated.resolvedMods.map((mod) => {
    assertApprovedCompilerArtifact(mod);
    return {
      provider: mod.provider,
      projectId: mod.projectId,
      fileId: mod.fileId,
      filename: mod.filename,
      sha256: mod.sha256,
      sizeBytes: mod.sizeBytes,
      downloadUrl: mod.downloadUrl,
    };
  }).sort((left, right) =>
    `${left.provider}:${left.projectId}:${left.fileId}`.localeCompare(
      `${right.provider}:${right.projectId}:${right.fileId}`,
    )
  );
  return {
    schemaVersion: 1,
    serviceId: imported.serviceId,
    importId: imported.importId,
    sourceFormat: imported.sourceFormat,
    archive: {
      key: imported.archiveKey,
      sha256: imported.expectedSha256,
      sizeBytes: imported.expectedSizeBytes,
    },
    compatibility: {
      minecraftVersion: compatibility.minecraftVersion,
      loader: resolved.loader,
      loaderVersion: compatibility.loaderVersion!,
      runtimeCatalog: { sha256: runtimeCatalog.sha256 },
    },
    configFiles: validated.configFiles.map(fileSummary).sort(
      sortPath,
    ),
    dataFiles: validated.dataFiles.map(fileSummary).sort(sortPath),
    mods,
  };
}

function validateCompiledContent(
  content: SharedRuntimeContentDescriptor,
  rawDescriptor: RuntimeDescriptor,
  deployment: SharedModdedDeployment,
) {
  const descriptor = validateRuntimeDescriptor(rawDescriptor);
  if (
    content.key !== deployment.expectedContentKey ||
    !validSha256(content.sha256) ||
    content.sha256 !== descriptor.contentSha256 ||
    !Number.isSafeInteger(content.compressedSize) ||
    content.compressedSize < 1 ||
    content.compressedSize > maxCompilerArtifactBytes ||
    !Number.isSafeInteger(content.logicalSize) || content.logicalSize < 1 ||
    content.logicalSize > maxCompilerArtifactBytes ||
    content.paths.length === 0 || content.paths.length > 100_000 ||
    !content.paths.includes(".xmcl/runtime.json") ||
    !content.paths.includes(".xmcl/launch.sh") ||
    content.paths.some((path) => !isCompilerContentPath(path))
  ) {
    throw new SharedModdedRuntimeError("content_invalid");
  }
  const resolved = resolveRuntimeCompatibility({
    minecraftVersion: deployment.frozenManifest.compatibility.minecraftVersion,
    loader: deployment.frozenManifest.compatibility.loader,
    loaderVersion: deployment.frozenManifest.compatibility.loaderVersion,
  });
  if (
    descriptor.minecraftVersion !==
      deployment.frozenManifest.compatibility.minecraftVersion ||
    descriptor.loader.kind !== resolved.loader ||
    descriptor.loader.version !==
      deployment.frozenManifest.compatibility.loaderVersion ||
    (deployment.frozenManifest.compatibility.java !== undefined &&
      (descriptor.java.component !==
          deployment.frozenManifest.compatibility.java.component ||
        descriptor.java.major !== deployment.frozenManifest.compatibility.java.major)) ||
    descriptor.runtimeCatalog.sha256 !==
      deployment.frozenManifest.compatibility.runtimeCatalog.sha256
  ) {
    throw new SharedModdedRuntimeError("content_invalid");
  }
}

function runtimeContentFor(
  deployment: SharedModdedDeployment,
): SharedRuntimeContent {
  if (!deployment.content) throw new SharedModdedRuntimeError("state_conflict");
  return {
    deploymentId: deployment.deploymentId,
    manifestSha256: deployment.manifestSha256,
    ...clone(deployment.content),
    eulaAccepted: true,
  };
}

function validateImportInput(input: {
  sourceFormat: string;
  expectedSha256: string;
  expectedSizeBytes: number;
  idempotencyKey: string;
}) {
  if (
    !["mrpack", "curseforge_zip", "xmcl_server_bundle"].includes(input.sourceFormat) ||
    !validSha256(input.expectedSha256) ||
    !Number.isSafeInteger(input.expectedSizeBytes) ||
    input.expectedSizeBytes < 1 ||
    input.expectedSizeBytes > maxCompilerArchiveBytes ||
    !validIdempotencyKey(input.idempotencyKey)
  ) {
    throw new SharedModdedRuntimeError("invalid_request");
  }
}

function assertApprovedCompilerArtifact(mod: ResolvedModSource) {
  if (
    !validSha256(mod.sha256) || !Number.isSafeInteger(mod.sizeBytes) ||
    mod.sizeBytes < 1 || mod.sizeBytes > maxCompilerArtifactBytes
  ) {
    throw new SharedModdedRuntimeError("invalid_import");
  }
  const hosts = mod.provider === "modrinth"
    ? ["cdn.modrinth.com"]
    : ["edge.forgecdn.net", "mediafilez.forgecdn.net"];
  try {
    assertProviderDownloadUrl(mod.downloadUrl, mod.provider, hosts);
  } catch {
    throw new SharedModdedRuntimeError("invalid_import");
  }
}

function fileSummary(file: ValidatedArchiveFile) {
  return { path: file.path, sha256: file.sha256, sizeBytes: file.sizeBytes };
}

function sortPath(
  left: { path: string },
  right: { path: string },
) {
  return left.path.localeCompare(right.path);
}

function invalidValidation(
  imported: SharedModdedImport,
): SharedRuntimeValidationReport {
  if (imported.sourceFormat === "xmcl_server_bundle") {
    return {
      importId: imported.importId,
      sourceFormat: imported.sourceFormat,
      status: "invalid",
      configFiles: [],
      dataFiles: [],
      mods: [],
      rejectedFiles: [{
        path: "$archive",
        reason: "archive_verification_failed",
      }],
    };
  }
  return {
    importId: imported.importId,
    sourceFormat: imported.sourceFormat,
    status: "invalid",
    configFiles: [],
    dataFiles: [],
    mods: [],
    rejectedFiles: [{
      path: "$archive",
      reason: "archive_verification_failed",
    }],
  };
}

function compilerInputKey(
  accountId: string,
  serviceId: string,
  importId: string,
  sourceFormat: ModpackSourceFormat,
) {
  const extension = sourceFormat === "xmcl_server_bundle"
    ? ".xmcl-server-bundle"
    : ".zip";
  return `shared-hosting/${accountId}/${serviceId}/compiler-inputs/${importId}${extension}`;
}

function compilerContentKey(
  accountId: string,
  serviceId: string,
  manifestSha256: string,
) {
  return `shared-hosting/${accountId}/${serviceId}/compiler-content/${manifestSha256}.tar.zst`;
}

function claimKey(value: Pick<Claim, "accountId" | "scope" | "key">) {
  return `${value.accountId}:${value.scope}:${value.key}`;
}

function parseMinecraftVersion(value: string) {
  const legacy = /^1\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(value);
  if (legacy) {
    return { major: 1, minor: Number(legacy[1]), patch: Number(legacy[2]) };
  }
  if (/^[1-9]\d{1,3}\.(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2}))?$/.test(value)) {
    return { major: 2, minor: 0, patch: 0 };
  }
  return undefined;
}

function validLoaderVersion(value: string) {
  return value.length > 0 && value.length <= 128 &&
    /^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(value);
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function validIdempotencyKey(value: string) {
  return value.length > 0 && value.length <= 255 &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    });
}

function isCompilerContentPath(path: string) {
  return path.length > 0 && path.length <= 1_024 &&
    !path.startsWith("/") && !path.includes("\\") &&
    path.split("/").every((part) => part && part !== "." && part !== "..") &&
    !(
      path === "world" || path.startsWith("world/") ||
      path === "world_nether" || path.startsWith("world_nether/") ||
      path === "world_the_end" || path.startsWith("world_the_end/") ||
      path === "config" || path.startsWith("config/") ||
      path === "defaultconfigs" || path.startsWith("defaultconfigs/")
    );
}

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

function canonicalJson(value: unknown) {
  return JSON.stringify(canonicalize(value));
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
