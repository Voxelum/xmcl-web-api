import type { Db } from "../db.ts";
import {
  isSharedNodeRegion,
  type SharedHostingScheduler,
  type SharedNodeCommand,
  type SharedNodeCommandGateway,
  type SharedWorkspace,
} from "./sharedHostingScheduler.ts";
import type { S3PresignedObject } from "./s3SigV4.ts";

const encoder = new TextEncoder();
const maxWorkspaceBlobCount = 130;
const maxWorkspacePathCount = 100_000;
const maxWorkspaceBytes = 64 * 1024 * 1024 * 1024;
// v2 uses single immutable PUTs only. Keep blobs below S3 multipart thresholds.
const maxWorkspaceBlobBytes = 4 * 1024 * 1024 * 1024;

/** Wire-format version shared with xmcl-shared-node-agent. */
export const SHARED_NODE_TRANSPORT_CONTRACT_VERSION = 1;
/** The isolated workspace grant protocol intentionally supersedes v1 credentials. */
export const SHARED_NODE_WORKSPACE_CONTRACT_VERSION = 2;

export class SharedNodeTransportError extends Error {
  constructor(
    readonly code:
      | "unauthorized"
      | "invalid_signature"
      | "stale_request"
      | "replay_detected"
      | "node_conflict"
      | "command_not_found"
      | "lease_conflict"
      | "lease_maximum_exceeded"
      | "invalid_request"
      | "unavailable"
      | "workspace_grant_denied",
  ) {
    super(code);
  }
}

export interface SharedNodeSignedRequest {
  method: string;
  path: string;
  body: string;
  authorization?: string;
  timestamp?: string;
  nonce?: string;
  bodyHash?: string;
  signature?: string;
}

export interface SharedNodeExpectedCapacity {
  totalMemoryMiB: number;
  totalSharedCpu: number;
  totalWorkspaceGiB: number;
}

export interface SharedNodeEnrollmentRecord {
  nodeId: string;
  provisioningRequestId: string;
  instanceId: string;
  expectedCapacity: SharedNodeExpectedCapacity;
  oneTimeTokenHash: string;
  expiresAt: string;
  consumedAt?: string;
}

export interface SharedNodeEnrollmentRepository {
  findEnrollment(
    nodeId: string,
  ): Promise<SharedNodeEnrollmentRecord | undefined>;
  saveEnrollment(record: SharedNodeEnrollmentRecord): Promise<void>;
  consumeEnrollment(input: {
    nodeId: string;
    tokenHash: string;
    expectedCapacity: SharedNodeExpectedCapacity;
    now: string;
  }): Promise<SharedNodeEnrollmentRecord | undefined>;
}

export interface SharedWorkspaceBlobDescriptor {
  key: string;
  sha256: string;
  compressedSize: number;
  logicalSize: number;
  /** Every archive member is explicit so extraction has no implicit mapping. */
  paths: readonly string[];
}

export interface SharedWorkspaceManifestDescriptor {
  schemaVersion: 2;
  serviceId: string;
  assignmentId: string;
  revision: number;
  createdAt: string;
  logicalSize: number;
  manifestHash: string;
  aggregateSha256: string;
  content?: SharedWorkspaceBlobDescriptor;
  config?: SharedWorkspaceBlobDescriptor;
  world: readonly SharedWorkspaceBlobDescriptor[];
}

export interface SharedWorkspaceGrantRequest {
  contractVersion: typeof SHARED_NODE_WORKSPACE_CONTRACT_VERSION;
  commandId: string;
  assignmentId: string;
  leaseToken: string;
  leaseGeneration: number;
  /** Restore requests select either the known manifest or manifest-owned blobs. */
  stage?: "manifest" | "blobs";
  keys?: readonly string[];
  manifest?: SharedWorkspaceManifestDescriptor;
  manifestSha256?: string;
}

export interface SharedWorkspaceGrant {
  key: string;
  method: "GET" | "PUT";
  url: string;
  expiresAt: string;
  headers?: Record<string, string>;
}

export interface SharedWorkspaceGrantResponse {
  contractVersion: typeof SHARED_NODE_WORKSPACE_CONTRACT_VERSION;
  grants: readonly SharedWorkspaceGrant[];
}

/** A server-only S3 signer; it returns grants but never its signing credential. */
export interface SharedNodeWorkspaceSigner {
  presign(
    key: string,
    method: "GET" | "PUT",
    expiresInSeconds: number,
  ): Promise<S3PresignedObject>;
}

export interface SharedWorkspaceManifestRecord {
  serviceId: string;
  accountId: string;
  assignmentId: string;
  commandId: string;
  revision: number;
  manifest: SharedWorkspaceManifestDescriptor;
  manifestSha256: string;
  status: "draft" | "published";
  createdAt: string;
}

export interface SharedWorkspaceManifestRepository {
  find(
    serviceId: string,
    revision: number,
  ): Promise<SharedWorkspaceManifestRecord | undefined>;
  findPublishedContent(
    serviceId: string,
    key: string,
  ): Promise<SharedWorkspaceBlobDescriptor | undefined>;
  findPublishedBlob(
    serviceId: string,
    key: string,
  ): Promise<SharedWorkspaceBlobDescriptor | undefined>;
  prepare(record: SharedWorkspaceManifestRecord): Promise<
    SharedWorkspaceManifestRecord
  >;
  markPublished(input: {
    serviceId: string;
    assignmentId: string;
    revision: number;
    manifestSha256?: string;
  }): Promise<void>;
}

/**
 * Compiler content is authorized independently of node workspace manifests.
 * Implementations must check that the service currently selected this exact
 * published deployment/content descriptor before a node GET is signed.
 */
export interface SharedRuntimeContentGrantAuthority {
  authorizeNodeRestore(input: {
    accountId: string;
    serviceId: string;
    deploymentId: string;
    manifestSha256: string;
    content: SharedWorkspaceBlobDescriptor;
  }): Promise<boolean>;
}

export interface SharedNodeHeartbeat {
  contractVersion: typeof SHARED_NODE_TRANSPORT_CONTRACT_VERSION;
  status: "ready" | "draining";
  capacity: {
    freeWorkspaceGiB: number;
    allocatableMemoryMiB: number;
    allocatableSharedCpu: number;
    activeContainerCount: number;
  };
  agentVersion: string;
  ingress: {
    host: string;
  };
}

export interface SharedNodeHeartbeatRecord extends SharedNodeHeartbeat {
  nodeId: string;
  receivedAt: string;
}

export interface SharedNodeIngressReservation {
  nodeId: string;
  serviceId: string;
  assignmentId: string;
  host: string;
  port: number;
  createdAt: string;
  releasedAt?: string;
}

/** Safe for a service projection: deliberately excludes node/assignment IDs. */
export interface SharedNodePublicEndpoint {
  host: string;
  port: number;
}

export interface SharedNodeIngressRepository {
  reserve(
    input: Omit<SharedNodeIngressReservation, "createdAt" | "releasedAt"> & {
      createdAt: string;
    },
  ): Promise<SharedNodeIngressReservation>;
  findByAssignment(
    nodeId: string,
    assignmentId: string,
  ): Promise<SharedNodeIngressReservation | undefined>;
  findActiveByService(
    serviceId: string,
  ): Promise<SharedNodeIngressReservation | undefined>;
  release(
    nodeId: string,
    assignmentId: string,
    releasedAt: string,
  ): Promise<void>;
}

export class MemorySharedNodeIngressRepository
  implements SharedNodeIngressRepository {
  private readonly reservations = new Map<
    string,
    SharedNodeIngressReservation
  >();
  private tail: Promise<void> = Promise.resolve();

  async reserve(input: SharedNodeIngressReservation) {
    return await this.transact(() => {
      const key = ingressKey(input.host, input.port);
      const existing = this.reservations.get(key);
      if (existing && !existing.releasedAt) {
        if (
          existing.nodeId !== input.nodeId ||
          existing.assignmentId !== input.assignmentId ||
          existing.serviceId !== input.serviceId
        ) {
          throw new SharedNodeTransportError("node_conflict");
        }
        return clone(existing);
      }
      const value = clone(input);
      this.reservations.set(key, value);
      return value;
    });
  }

  async findByAssignment(nodeId: string, assignmentId: string) {
    return clone(
      [...this.reservations.values()].find((reservation) =>
        reservation.nodeId === nodeId &&
        reservation.assignmentId === assignmentId &&
        !reservation.releasedAt
      ),
    );
  }

  async findActiveByService(serviceId: string) {
    return clone(
      [...this.reservations.values()].find((reservation) =>
        reservation.serviceId === serviceId && !reservation.releasedAt
      ),
    );
  }

  async release(nodeId: string, assignmentId: string, releasedAt: string) {
    await this.transact(() => {
      for (const reservation of this.reservations.values()) {
        if (
          reservation.nodeId === nodeId &&
          reservation.assignmentId === assignmentId &&
          !reservation.releasedAt
        ) {
          reservation.releasedAt = releasedAt;
        }
      }
    });
  }

  private async transact<T>(mutation: () => T): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => release = resolve);
    await previous;
    try {
      return clone(mutation());
    } finally {
      release();
    }
  }
}

export interface SharedNodeCommandOutbox {
  enqueue(command: SharedNodeCommand): Promise<void>;
  next(
    nodeId: string,
    now: string,
    leaseMs: number,
  ): Promise<
    {
      command: SharedNodeCommand;
      leaseToken: string;
      leaseGeneration: number;
      leaseExpiresAt: string;
    } | undefined
  >;
  acknowledge(input: {
    nodeId: string;
    commandId: string;
    leaseToken: string;
    leaseGeneration: number;
    now: string;
  }): Promise<void>;
  renew(input: {
    nodeId: string;
    commandId: string;
    leaseToken: string;
    leaseGeneration: number;
    now: string;
    leaseMs: number;
    maxLifetimeMs: number;
  }): Promise<{ leaseExpiresAt: string }>;
  leased(input: {
    nodeId: string;
    commandId: string;
    leaseToken: string;
    leaseGeneration: number;
    now: string;
  }): Promise<SharedNodeCommand>;
  requeueExpired(now: string): Promise<number>;
}

/**
 * Reserves the externally reachable port before an agent can receive a command.
 * A missing heartbeat ingress host is deliberately a dispatch failure: agents
 * must never fall back to a node-local hash-derived port.
 */
export class SharedNodeIngressAssignmentProvider {
  private readonly portMin: number;
  private readonly portMax: number;

  constructor(
    private readonly reservations: SharedNodeIngressRepository,
    private readonly heartbeats: Pick<
      SharedNodeCredentialRepository,
      "findHeartbeat"
    >,
    options: {
      now?: () => Date;
      portMin?: number;
      portMax?: number;
    } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.portMin = options.portMin ?? 25565;
    this.portMax = options.portMax ?? 25665;
    if (
      !Number.isSafeInteger(this.portMin) ||
      !Number.isSafeInteger(this.portMax) ||
      this.portMin < 1024 ||
      this.portMax > 65535 ||
      this.portMin > this.portMax
    ) {
      throw new Error("shared node ingress port range is invalid");
    }
  }

  private readonly now: () => Date;

  async reserve(command: SharedNodeCommand) {
    const existing = await this.reservations.findByAssignment(
      command.nodeId,
      command.assignmentId,
    );
    if (existing) {
      if (existing.serviceId !== command.serviceId) {
        throw new SharedNodeTransportError("node_conflict");
      }
      return { host: existing.host, hostPort: existing.port };
    }
    const heartbeat = await this.heartbeats.findHeartbeat(command.nodeId);
    if (!heartbeat?.ingress?.host) {
      throw new SharedNodeTransportError("unavailable");
    }
    validateIngressEndpoint({ host: heartbeat.ingress.host }, true);
    for (const port of ingressPortCandidates(this.portMin, this.portMax)) {
      try {
        const reservation = await this.reservations.reserve({
          nodeId: command.nodeId,
          serviceId: command.serviceId,
          assignmentId: command.assignmentId,
          host: heartbeat.ingress.host,
          port,
          createdAt: this.now().toISOString(),
        });
        return { host: reservation.host, hostPort: reservation.port };
      } catch (error) {
        if (!(error instanceof SharedNodeTransportError)) throw error;
      }
    }
    throw new SharedNodeTransportError("unavailable");
  }
}

export class DurableSharedNodeCommandGateway
  implements SharedNodeCommandGateway {
  constructor(
    private readonly outbox: SharedNodeCommandOutbox,
    private readonly ingress: SharedNodeIngressAssignmentProvider,
  ) {}

  async dispatch(command: SharedNodeCommand) {
    if (command.connection) {
      throw new SharedNodeTransportError("invalid_request");
    }
    const connection = await this.ingress.reserve(command);
    await this.outbox.enqueue({ ...command, connection });
  }
}

interface StoredCommand extends SharedNodeCommand {
  _id: string;
  outboxStatus: "queued" | "leased" | "acked";
  createdAt: string;
  leaseExpiresAt?: string;
  acknowledgedAt?: string;
  leaseToken?: string;
  leaseGeneration: number;
  leaseStartedAt?: string;
  leaseRenewedAt?: string;
  leaseRenewals: number;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function commandFingerprint(command: SharedNodeCommand) {
  return JSON.stringify({
    commandId: command.commandId,
    kind: command.kind,
    nodeId: command.nodeId,
    serviceId: command.serviceId,
    assignmentId: command.assignmentId,
    accountId: command.accountId,
    workspace: command.workspace,
    resources: command.resources,
    connection: command.connection,
  });
}

export class MemorySharedNodeCommandOutbox implements SharedNodeCommandOutbox {
  private readonly commands = new Map<string, StoredCommand>();
  private tail: Promise<void> = Promise.resolve();

  async enqueue(command: SharedNodeCommand) {
    await this.transact(() => {
      const existing = this.commands.get(command.commandId);
      if (existing) {
        if (commandFingerprint(existing) !== commandFingerprint(command)) {
          throw new SharedNodeTransportError("node_conflict");
        }
        return;
      }
      this.commands.set(command.commandId, {
        ...clone(command),
        _id: command.commandId,
        outboxStatus: "queued",
        createdAt: new Date().toISOString(),
        leaseGeneration: 0,
        leaseRenewals: 0,
      });
    });
  }

  async next(nodeId: string, now: string, leaseMs: number) {
    return await this.transact(() => {
      const current = [...this.commands.values()].find((item) =>
        item.nodeId === nodeId &&
        item.outboxStatus === "leased" &&
        Date.parse(item.leaseExpiresAt ?? "") > Date.parse(now)
      );
      if (current) return undefined;
      for (const item of this.commands.values()) {
        if (
          item.nodeId === nodeId &&
          item.outboxStatus === "leased" &&
          Date.parse(item.leaseExpiresAt ?? "") <= Date.parse(now)
        ) {
          item.outboxStatus = "queued";
          item.leaseExpiresAt = undefined;
        }
      }
      const next = [...this.commands.values()]
        .filter((item) =>
          item.nodeId === nodeId && item.outboxStatus === "queued"
        )
        .sort((left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.commandId.localeCompare(right.commandId)
        )[0];
      if (!next) return undefined;
      const leaseExpiresAt = new Date(
        Date.parse(now) + leaseMs,
      ).toISOString();
      const leaseToken = crypto.randomUUID();
      next.outboxStatus = "leased";
      next.leaseGeneration += 1;
      next.leaseToken = leaseToken;
      next.leaseStartedAt = now;
      next.leaseRenewals = 0;
      next.leaseExpiresAt = leaseExpiresAt;
      return {
        command: clone(next),
        leaseToken,
        leaseGeneration: next.leaseGeneration,
        leaseExpiresAt,
      };
    });
  }

  async acknowledge(input: {
    nodeId: string;
    commandId: string;
    leaseToken: string;
    leaseGeneration: number;
    now: string;
  }) {
    await this.transact(() => {
      const command = this.commands.get(input.commandId);
      if (!command || command.nodeId !== input.nodeId) {
        throw new SharedNodeTransportError("command_not_found");
      }
      if (command.outboxStatus === "acked") return;
      if (
        command.outboxStatus !== "leased" ||
        command.leaseToken !== input.leaseToken ||
        command.leaseGeneration !== input.leaseGeneration ||
        Date.parse(command.leaseExpiresAt ?? "") <= Date.parse(input.now)
      ) {
        throw new SharedNodeTransportError("lease_conflict");
      }
      command.outboxStatus = "acked";
      command.acknowledgedAt = input.now;
      command.leaseExpiresAt = undefined;
      command.leaseToken = undefined;
    });
  }

  async renew(input: {
    nodeId: string;
    commandId: string;
    leaseToken: string;
    leaseGeneration: number;
    now: string;
    leaseMs: number;
    maxLifetimeMs: number;
  }) {
    return await this.transact(() => {
      const command = this.commands.get(input.commandId);
      if (
        !command || command.nodeId !== input.nodeId ||
        command.outboxStatus !== "leased" ||
        command.leaseToken !== input.leaseToken ||
        command.leaseGeneration !== input.leaseGeneration ||
        Date.parse(command.leaseExpiresAt ?? "") <= Date.parse(input.now)
      ) {
        throw new SharedNodeTransportError("lease_conflict");
      }
      const maximum = Date.parse(command.leaseStartedAt ?? input.now) +
        input.maxLifetimeMs;
      const leaseExpiresAt = new Date(
        Math.min(Date.parse(input.now) + input.leaseMs, maximum),
      ).toISOString();
      if (Date.parse(leaseExpiresAt) <= Date.parse(input.now)) {
        throw new SharedNodeTransportError("lease_maximum_exceeded");
      }
      command.leaseExpiresAt = leaseExpiresAt;
      command.leaseRenewals += 1;
      return { leaseExpiresAt };
    });
  }

  async leased(input: {
    nodeId: string;
    commandId: string;
    leaseToken: string;
    leaseGeneration: number;
    now: string;
  }) {
    return await this.transact(() => {
      const command = this.commands.get(input.commandId);
      if (
        !command || command.nodeId !== input.nodeId ||
        command.outboxStatus !== "leased" ||
        command.leaseToken !== input.leaseToken ||
        command.leaseGeneration !== input.leaseGeneration ||
        Date.parse(command.leaseExpiresAt ?? "") <= Date.parse(input.now)
      ) {
        throw new SharedNodeTransportError("lease_conflict");
      }
      return command;
    });
  }

  async requeueExpired(now: string) {
    return await this.transact(() => {
      let count = 0;
      for (const command of this.commands.values()) {
        if (
          command.outboxStatus === "leased" &&
          Date.parse(command.leaseExpiresAt ?? "") <= Date.parse(now)
        ) {
          command.outboxStatus = "queued";
          command.leaseExpiresAt = undefined;
          count += 1;
        }
      }
      return count;
    });
  }

  private async transact<T>(mutation: () => T): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => release = resolve);
    await previous;
    try {
      return clone(mutation());
    } finally {
      release();
    }
  }
}

export class MongoSharedNodeCommandOutbox implements SharedNodeCommandOutbox {
  constructor(private readonly db: Db) {}

  async enqueue(command: SharedNodeCommand) {
    const collection = this.collection();
    await collection.updateOne(
      { _id: command.commandId },
      {
        $setOnInsert: {
          ...clone(command),
          _id: command.commandId,
          outboxStatus: "queued",
          createdAt: new Date().toISOString(),
          leaseGeneration: 0,
          leaseRenewals: 0,
        },
      },
      { upsert: true },
    );
    const existing = await collection.findOne({ _id: command.commandId }) as
      | StoredCommand
      | undefined;
    if (
      !existing || commandFingerprint(existing) !== commandFingerprint(command)
    ) {
      throw new SharedNodeTransportError("node_conflict");
    }
  }

  async next(nodeId: string, now: string, leaseMs: number) {
    const existing = await this.collection().findOne({
      nodeId,
      outboxStatus: "leased",
      leaseExpiresAt: { $gt: now },
    }) as StoredCommand | undefined;
    if (existing) return undefined;
    await this.collection().updateOne(
      { nodeId, outboxStatus: "leased", leaseExpiresAt: { $lte: now } },
      {
        $set: { outboxStatus: "queued" },
        $unset: { leaseExpiresAt: "", leaseToken: "" },
      },
    );
    const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
    const leaseToken = crypto.randomUUID();
    const found = await this.collection().findOneAndUpdate(
      { nodeId, outboxStatus: "queued" },
      {
        $set: {
          outboxStatus: "leased",
          leaseExpiresAt,
          leaseToken,
          leaseStartedAt: now,
          leaseRenewals: 0,
        },
        $inc: { leaseGeneration: 1 },
      },
      { sort: { createdAt: 1 }, returnDocument: "after" },
    );
    const command = ((found && "value" in found) ? found.value : found) as
      | StoredCommand
      | undefined;
    return command
      ? {
        command: clone(command),
        leaseToken: command.leaseToken!,
        leaseGeneration: command.leaseGeneration,
        leaseExpiresAt,
      }
      : undefined;
  }

  async acknowledge(input: {
    nodeId: string;
    commandId: string;
    leaseToken: string;
    leaseGeneration: number;
    now: string;
  }) {
    const collection = this.collection();
    const command = await collection.findOne({ _id: input.commandId }) as
      | StoredCommand
      | undefined;
    if (!command || command.nodeId !== input.nodeId) {
      throw new SharedNodeTransportError("command_not_found");
    }
    if (command.outboxStatus === "acked") return;
    if (
      command.outboxStatus !== "leased" ||
      command.leaseToken !== input.leaseToken ||
      command.leaseGeneration !== input.leaseGeneration ||
      Date.parse(command.leaseExpiresAt ?? "") <= Date.parse(input.now)
    ) {
      throw new SharedNodeTransportError("lease_conflict");
    }
    const updated = await collection.findOneAndUpdate(
      {
        _id: input.commandId,
        nodeId: input.nodeId,
        outboxStatus: "leased",
        leaseToken: input.leaseToken,
        leaseGeneration: input.leaseGeneration,
        leaseExpiresAt: { $gt: input.now },
      },
      {
        $set: {
          outboxStatus: "acked",
          acknowledgedAt: input.now,
        },
        $unset: { leaseExpiresAt: "", leaseToken: "" },
      },
      { returnDocument: "before" },
    );
    if (!updated) throw new SharedNodeTransportError("lease_conflict");
  }

  async renew(input: {
    nodeId: string;
    commandId: string;
    leaseToken: string;
    leaseGeneration: number;
    now: string;
    leaseMs: number;
    maxLifetimeMs: number;
  }) {
    const command = await this.collection().findOne({
      _id: input.commandId,
      nodeId: input.nodeId,
      outboxStatus: "leased",
      leaseToken: input.leaseToken,
      leaseGeneration: input.leaseGeneration,
      leaseExpiresAt: { $gt: input.now },
    }) as StoredCommand | undefined;
    if (!command) throw new SharedNodeTransportError("lease_conflict");
    const maximum = Date.parse(command.leaseStartedAt ?? input.now) +
      input.maxLifetimeMs;
    const leaseExpiresAt = new Date(
      Math.min(Date.parse(input.now) + input.leaseMs, maximum),
    ).toISOString();
    if (Date.parse(leaseExpiresAt) <= Date.parse(input.now)) {
      throw new SharedNodeTransportError("lease_maximum_exceeded");
    }
    const updated = await this.collection().findOneAndUpdate(
      {
        _id: input.commandId,
        nodeId: input.nodeId,
        outboxStatus: "leased",
        leaseToken: input.leaseToken,
        leaseGeneration: input.leaseGeneration,
        leaseExpiresAt: { $gt: input.now },
      },
      {
        $set: { leaseExpiresAt, leaseRenewedAt: input.now },
        $inc: { leaseRenewals: 1 },
      },
      { returnDocument: "after" },
    );
    if (!updated) throw new SharedNodeTransportError("lease_conflict");
    return { leaseExpiresAt };
  }

  async leased(input: {
    nodeId: string;
    commandId: string;
    leaseToken: string;
    leaseGeneration: number;
    now: string;
  }) {
    const command = await this.collection().findOne({
      _id: input.commandId,
      nodeId: input.nodeId,
      outboxStatus: "leased",
      leaseToken: input.leaseToken,
      leaseGeneration: input.leaseGeneration,
      leaseExpiresAt: { $gt: input.now },
    }) as StoredCommand | undefined;
    if (!command) throw new SharedNodeTransportError("lease_conflict");
    return clone(command);
  }

  async requeueExpired(now: string) {
    let count = 0;
    while (true) {
      const result = await this.collection().findOneAndUpdate(
        { outboxStatus: "leased", leaseExpiresAt: { $lte: now } },
        {
          $set: { outboxStatus: "queued" },
          $unset: { leaseExpiresAt: "", leaseToken: "" },
        },
      );
      if (!result) return count;
      count += 1;
    }
  }

  private collection() {
    return this.db.collection("shared_node_command_outbox");
  }
}

export interface SharedNodeCredentialRecord {
  nodeId: string;
  tokenHash: string;
  expiresAt: string;
}

export interface SharedNodeCredentialRepository {
  findCredential(
    nodeId: string,
  ): Promise<SharedNodeCredentialRecord | undefined>;
  saveCredential(record: SharedNodeCredentialRecord): Promise<void>;
  saveEnrollment(record: SharedNodeEnrollmentRecord): Promise<void>;
  consumeEnrollment(input: {
    nodeId: string;
    tokenHash: string;
    expectedCapacity: SharedNodeExpectedCapacity;
    now: string;
  }): Promise<SharedNodeEnrollmentRecord | undefined>;
  claimNonce(input: {
    nodeId: string;
    nonce: string;
    fingerprint: string;
    expiresAt: string;
  }): Promise<"claimed" | "replayed">;
  saveHeartbeat(record: SharedNodeHeartbeatRecord): Promise<void>;
  findHeartbeat(nodeId: string): Promise<SharedNodeHeartbeatRecord | undefined>;
}

export class MemorySharedNodeCredentialRepository
  implements SharedNodeCredentialRepository {
  private readonly credentials = new Map<string, SharedNodeCredentialRecord>();
  private readonly enrollments = new Map<string, SharedNodeEnrollmentRecord>();
  private readonly nonces = new Map<string, string>();
  private readonly heartbeats = new Map<string, SharedNodeHeartbeatRecord>();

  findCredential(nodeId: string) {
    return Promise.resolve(clone(this.credentials.get(nodeId)));
  }

  saveCredential(record: SharedNodeCredentialRecord) {
    this.credentials.set(record.nodeId, clone(record));
    return Promise.resolve();
  }

  saveEnrollment(record: SharedNodeEnrollmentRecord) {
    this.enrollments.set(record.nodeId, clone(record));
    return Promise.resolve();
  }

  findEnrollment(nodeId: string) {
    return Promise.resolve(clone(this.enrollments.get(nodeId)));
  }

  consumeEnrollment(input: {
    nodeId: string;
    tokenHash: string;
    expectedCapacity: SharedNodeExpectedCapacity;
    now: string;
  }) {
    const record = this.enrollments.get(input.nodeId);
    if (
      !record ||
      record.consumedAt ||
      record.oneTimeTokenHash !== input.tokenHash ||
      Date.parse(record.expiresAt) <= Date.parse(input.now) ||
      JSON.stringify(record.expectedCapacity) !==
        JSON.stringify(input.expectedCapacity)
    ) {
      return Promise.resolve(undefined);
    }
    record.consumedAt = input.now;
    return Promise.resolve(clone(record));
  }

  claimNonce(input: {
    nodeId: string;
    nonce: string;
    fingerprint: string;
    expiresAt: string;
  }) {
    const key = `${input.nodeId}:${input.nonce}`;
    const existing = this.nonces.get(key);
    if (existing) return Promise.resolve("replayed" as const);
    this.nonces.set(key, input.fingerprint);
    return Promise.resolve("claimed" as const);
  }

  saveHeartbeat(record: SharedNodeHeartbeatRecord) {
    this.heartbeats.set(record.nodeId, clone(record));
    return Promise.resolve();
  }

  findHeartbeat(nodeId: string) {
    return Promise.resolve(clone(this.heartbeats.get(nodeId)));
  }
}

export class MongoSharedNodeCredentialRepository
  implements SharedNodeCredentialRepository {
  constructor(private readonly db: Db) {}

  async findCredential(nodeId: string) {
    const value = await this.db.collection("shared_node_credentials").findOne({
      _id: nodeId,
    }) as SharedNodeCredentialRecord | undefined;
    return value
      ? {
        nodeId: value.nodeId,
        tokenHash: value.tokenHash,
        expiresAt: value.expiresAt,
      }
      : undefined;
  }

  async saveCredential(record: SharedNodeCredentialRecord) {
    await this.db.collection("shared_node_credentials").replaceOne(
      { _id: record.nodeId },
      { ...record, _id: record.nodeId },
      { upsert: true },
    );
  }

  async saveEnrollment(record: SharedNodeEnrollmentRecord) {
    await this.db.collection("shared_node_enrollments").replaceOne(
      { _id: record.nodeId },
      { ...record, _id: record.nodeId },
      { upsert: true },
    );
  }

  async findEnrollment(nodeId: string) {
    const value = await this.db.collection("shared_node_enrollments").findOne({
      _id: nodeId,
    });
    return value as SharedNodeEnrollmentRecord | undefined;
  }

  async consumeEnrollment(input: {
    nodeId: string;
    tokenHash: string;
    expectedCapacity: SharedNodeExpectedCapacity;
    now: string;
  }) {
    const found = await this.db.collection("shared_node_enrollments")
      .findOneAndUpdate(
        {
          _id: input.nodeId,
          nodeId: input.nodeId,
          oneTimeTokenHash: input.tokenHash,
          expectedCapacity: input.expectedCapacity,
          expiresAt: { $gt: input.now },
          consumedAt: { $exists: false },
        },
        { $set: { consumedAt: input.now } },
        { returnDocument: "after" },
      );
    return ((found && "value" in found) ? found.value : found) as
      | SharedNodeEnrollmentRecord
      | undefined;
  }

  async claimNonce(input: {
    nodeId: string;
    nonce: string;
    fingerprint: string;
    expiresAt: string;
  }) {
    const result = await this.db.collection("shared_node_request_nonces")
      .findOneAndUpdate(
        { _id: `${input.nodeId}:${input.nonce}` },
        {
          $setOnInsert: {
            _id: `${input.nodeId}:${input.nonce}`,
            fingerprint: input.fingerprint,
            expiresAt: input.expiresAt,
          },
        },
        { returnDocument: "before" },
      );
    return result ? "replayed" as const : "claimed" as const;
  }

  async saveHeartbeat(record: SharedNodeHeartbeatRecord) {
    await this.db.collection("shared_node_heartbeats").replaceOne(
      { _id: record.nodeId },
      { ...clone(record), _id: record.nodeId },
      { upsert: true },
    );
  }

  async findHeartbeat(nodeId: string) {
    const value = await this.db.collection("shared_node_heartbeats").findOne({
      _id: nodeId,
    }) as SharedNodeHeartbeatRecord | undefined;
    return value ? clone(value) : undefined;
  }
}

export class MongoSharedNodeIngressRepository
  implements SharedNodeIngressRepository {
  constructor(private readonly db: Db) {}

  async reserve(input: SharedNodeIngressReservation) {
    const key = ingressKey(input.host, input.port);
    try {
      await this.collection().updateOne(
        {
          _id: key,
          $or: [
            { releasedAt: { $exists: true } },
            {
              nodeId: input.nodeId,
              assignmentId: input.assignmentId,
              serviceId: input.serviceId,
            },
          ],
        },
        {
          $set: { ...clone(input), _id: key },
          $unset: { releasedAt: "" },
        },
        { upsert: true },
      );
    } catch {
      throw new SharedNodeTransportError("node_conflict");
    }
    const reservation = await this.collection().findOne({ _id: key }) as
      | SharedNodeIngressReservation
      | undefined;
    if (
      !reservation ||
      reservation.releasedAt ||
      reservation.nodeId !== input.nodeId ||
      reservation.assignmentId !== input.assignmentId ||
      reservation.serviceId !== input.serviceId
    ) {
      throw new SharedNodeTransportError("node_conflict");
    }
    return clone(reservation);
  }

  async findByAssignment(nodeId: string, assignmentId: string) {
    const reservation = await this.collection().findOne({
      nodeId,
      assignmentId,
      releasedAt: { $exists: false },
    }) as SharedNodeIngressReservation | undefined;
    return reservation ? clone(reservation) : undefined;
  }

  async findActiveByService(serviceId: string) {
    const reservation = await this.collection().findOne({
      serviceId,
      releasedAt: { $exists: false },
    }) as SharedNodeIngressReservation | undefined;
    return reservation ? clone(reservation) : undefined;
  }

  async release(nodeId: string, assignmentId: string, releasedAt: string) {
    await this.collection().updateOne(
      { nodeId, assignmentId, releasedAt: { $exists: false } },
      { $set: { releasedAt } },
    );
  }

  private collection() {
    return this.db.collection("shared_node_ingress_reservations");
  }
}

/**
 * Durable metadata for published v2 manifests.  The object bucket is never
 * enumerated by a node; this is the authority used to constrain restore keys
 * and to prevent a later command from acquiring an overwrite grant.
 */
export class MemorySharedWorkspaceManifestRepository
  implements SharedWorkspaceManifestRepository {
  private readonly records = new Map<string, SharedWorkspaceManifestRecord>();
  private tail: Promise<void> = Promise.resolve();

  async find(serviceId: string, revision: number) {
    await this.tail;
    return clone(
      this.records.get(workspaceManifestRecordKey(serviceId, revision)),
    );
  }

  async findPublishedContent(serviceId: string, key: string) {
    await this.tail;
    for (const record of this.records.values()) {
      if (record.serviceId !== serviceId || record.status !== "published") {
        continue;
      }
      if (record.manifest.content?.key === key) {
        return clone(record.manifest.content);
      }
    }
    return undefined;
  }

  async findPublishedBlob(serviceId: string, key: string) {
    await this.tail;
    for (const record of this.records.values()) {
      if (record.serviceId !== serviceId || record.status !== "published") {
        continue;
      }
      const descriptor = manifestBlobDescriptors(record.manifest).find((item) =>
        item.key === key
      );
      if (descriptor) return clone(descriptor);
    }
    return undefined;
  }

  async prepare(record: SharedWorkspaceManifestRecord) {
    return await this.transact(() => {
      const key = workspaceManifestRecordKey(record.serviceId, record.revision);
      const existing = this.records.get(key);
      if (existing) {
        if (
          existing.status === "published" ||
          existing.commandId !== record.commandId ||
          existing.assignmentId !== record.assignmentId ||
          existing.manifestSha256 !== record.manifestSha256 ||
          JSON.stringify(existing.manifest) !== JSON.stringify(record.manifest)
        ) {
          throw new SharedNodeTransportError("workspace_grant_denied");
        }
        return existing;
      }
      this.records.set(key, clone(record));
      return record;
    });
  }

  async markPublished(input: {
    serviceId: string;
    assignmentId: string;
    revision: number;
    manifestSha256?: string;
  }) {
    await this.transact(() => {
      const record = this.records.get(
        workspaceManifestRecordKey(input.serviceId, input.revision),
      );
      if (
        !record || record.assignmentId !== input.assignmentId ||
        (input.manifestSha256 && record.manifestSha256 !== input.manifestSha256)
      ) {
        throw new SharedNodeTransportError("workspace_grant_denied");
      }
      record.status = "published";
    });
  }

  private async transact<T>(mutation: () => T) {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => release = resolve);
    await previous;
    try {
      return clone(mutation());
    } finally {
      release();
    }
  }
}

export class MongoSharedWorkspaceManifestRepository
  implements SharedWorkspaceManifestRepository {
  constructor(private readonly db: Db) {}

  async find(serviceId: string, revision: number) {
    const record = await this.collection().findOne({
      _id: workspaceManifestRecordKey(serviceId, revision),
    }) as SharedWorkspaceManifestRecord | undefined;
    return record ? clone(record) : undefined;
  }

  async findPublishedContent(serviceId: string, key: string) {
    const record = await this.collection().findOne({
      serviceId,
      status: "published",
      "manifest.content.key": key,
    }) as SharedWorkspaceManifestRecord | undefined;
    return record?.manifest.content
      ? clone(record.manifest.content)
      : undefined;
  }

  async findPublishedBlob(serviceId: string, key: string) {
    const record = await this.collection().findOne({
      serviceId,
      status: "published",
      $or: [
        { "manifest.content.key": key },
        { "manifest.config.key": key },
        { "manifest.world.key": key },
      ],
    }) as SharedWorkspaceManifestRecord | undefined;
    return record
      ? clone(
        manifestBlobDescriptors(record.manifest).find((item) =>
          item.key === key
        ),
      )
      : undefined;
  }

  async prepare(record: SharedWorkspaceManifestRecord) {
    const key = workspaceManifestRecordKey(record.serviceId, record.revision);
    await this.collection().updateOne(
      { _id: key },
      { $setOnInsert: { ...clone(record), _id: key } },
      { upsert: true },
    );
    const current = await this.collection().findOne({ _id: key }) as
      | SharedWorkspaceManifestRecord
      | undefined;
    if (
      !current || current.status === "published" ||
      current.commandId !== record.commandId ||
      current.assignmentId !== record.assignmentId ||
      current.manifestSha256 !== record.manifestSha256 ||
      JSON.stringify(current.manifest) !== JSON.stringify(record.manifest)
    ) {
      throw new SharedNodeTransportError("workspace_grant_denied");
    }
    return clone(current);
  }

  async markPublished(input: {
    serviceId: string;
    assignmentId: string;
    revision: number;
    manifestSha256?: string;
  }) {
    const result = await this.collection().findOneAndUpdate(
      {
        _id: workspaceManifestRecordKey(input.serviceId, input.revision),
        assignmentId: input.assignmentId,
        status: { $in: ["draft", "published"] },
        ...(input.manifestSha256
          ? { manifestSha256: input.manifestSha256 }
          : {}),
      },
      { $set: { status: "published" } },
      { returnDocument: "after" },
    );
    if (!result) throw new SharedNodeTransportError("workspace_grant_denied");
  }

  private collection() {
    return this.db.collection("shared_workspace_manifests");
  }
}

export async function issueSharedNodeCredential(
  nodeId: string,
  now: string,
  ttlMs: number,
) {
  const secret = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const token = `${nodeId}.${secret}`;
  return {
    token,
    record: {
      nodeId,
      tokenHash: await hashSharedNodeToken(token),
      expiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
    } satisfies SharedNodeCredentialRecord,
  };
}

export interface SharedNodeRegistration {
  nodeId: string;
  region: string;
  totalMemoryMiB: number;
  totalSharedCpu: number;
  totalWorkspaceGiB: number;
}

export interface SharedNodeTransportOptions {
  credentialRepository: SharedNodeCredentialRepository;
  enrollmentRepository: SharedNodeEnrollmentRepository;
  commandOutbox: SharedNodeCommandOutbox;
  scheduler: SharedHostingScheduler;
  now?: () => Date;
  credentialTtlMs?: number;
  requestClockSkewMs?: number;
  commandLeaseMs?: number;
  commandMaxLifetimeMs?: number;
  workspaceSigner?: SharedNodeWorkspaceSigner;
  workspaceManifestRepository?: SharedWorkspaceManifestRepository;
  workspaceGrantTtlMs?: number;
  ingressRepository?: SharedNodeIngressRepository;
  runtimeContentGrantAuthority?: SharedRuntimeContentGrantAuthority;
}

export class SharedNodeTransportService {
  private readonly now: () => Date;
  private readonly credentialTtlMs: number;
  private readonly requestClockSkewMs: number;
  private readonly commandLeaseMs: number;
  private readonly commandMaxLifetimeMs: number;
  private readonly workspaceGrantTtlMs: number;

  constructor(private readonly options: SharedNodeTransportOptions) {
    this.now = options.now ?? (() => new Date());
    this.credentialTtlMs = options.credentialTtlMs ?? 15 * 60_000;
    this.requestClockSkewMs = options.requestClockSkewMs ?? 30_000;
    this.commandLeaseMs = options.commandLeaseMs ?? 60_000;
    this.commandMaxLifetimeMs = options.commandMaxLifetimeMs ?? 30 * 60_000;
    this.workspaceGrantTtlMs = options.workspaceGrantTtlMs ?? 10 * 60_000;
    if (
      !Number.isSafeInteger(this.workspaceGrantTtlMs) ||
      this.workspaceGrantTtlMs < 1_000 ||
      this.workspaceGrantTtlMs > 15 * 60_000
    ) {
      throw new Error(
        "workspace grant TTL must be between one second and fifteen minutes",
      );
    }
  }

  async dispatch(command: SharedNodeCommand) {
    if (!command.connection) {
      throw new SharedNodeTransportError("invalid_request");
    }
    validateIngressEndpoint({
      host: command.connection.host,
      port: command.connection.hostPort,
    });
    await this.options.commandOutbox.enqueue(command);
  }

  async register(
    input: SharedNodeRegistration,
    request: SharedNodeSignedRequest & { bootstrapCredential?: string },
  ) {
    if (
      !isSharedNodeRegion(input.region) ||
      !this.options.scheduler.isPoolRegion(input.region)
    ) {
      throw new SharedNodeTransportError("invalid_request");
    }
    const credential = request.bootstrapCredential;
    const now = this.now().toISOString();
    if (!credential) throw new SharedNodeTransportError("unauthorized");
    await this.authenticateBootstrap(request, credential, input.nodeId);
    const active = await this.options.credentialRepository.findCredential(
      input.nodeId,
    );
    if (active && Date.parse(active.expiresAt) > this.now().getTime()) {
      throw new SharedNodeTransportError("node_conflict");
    }
    const enrollment = await this.options.enrollmentRepository
      .consumeEnrollment({
        nodeId: input.nodeId,
        tokenHash: await hashSharedNodeToken(credential),
        expectedCapacity: {
          totalMemoryMiB: input.totalMemoryMiB,
          totalSharedCpu: input.totalSharedCpu,
          totalWorkspaceGiB: input.totalWorkspaceGiB,
        },
        now,
      });
    if (!enrollment) throw new SharedNodeTransportError("unauthorized");
    await this.options.scheduler.registerNode({
      ...input,
      status: "ready",
    });
    const issued = await issueSharedNodeCredential(
      input.nodeId,
      now,
      this.credentialTtlMs,
    );
    await this.options.credentialRepository.saveCredential(issued.record);
    return {
      contractVersion: SHARED_NODE_TRANSPORT_CONTRACT_VERSION,
      nodeId: input.nodeId,
      credential: issued.token,
      expiresAt: issued.record.expiresAt,
    };
  }

  async heartbeat(
    nodeId: string,
    heartbeat: SharedNodeHeartbeat,
    request: SharedNodeSignedRequest,
  ) {
    await this.authenticateNode(nodeId, request);
    validateHeartbeat(heartbeat);
    await this.options.credentialRepository.saveHeartbeat({
      ...clone(heartbeat),
      nodeId,
      receivedAt: this.now().toISOString(),
    });
    await this.options.scheduler.heartbeatNode(nodeId, heartbeat.status);
    return {
      contractVersion: SHARED_NODE_TRANSPORT_CONTRACT_VERSION,
      accepted: true,
    };
  }

  async nextCommand(nodeId: string, request: SharedNodeSignedRequest) {
    await this.authenticateNode(nodeId, request);
    return await this.options.commandOutbox.next(
      nodeId,
      this.now().toISOString(),
      this.commandLeaseMs,
    );
  }

  async acknowledge(
    nodeId: string,
    commandId: string,
    leaseToken: string,
    leaseGeneration: number,
    request: SharedNodeSignedRequest,
  ) {
    await this.authenticateNode(nodeId, request);
    await this.options.commandOutbox.acknowledge({
      nodeId,
      commandId,
      leaseToken,
      leaseGeneration,
      now: this.now().toISOString(),
    });
    return {
      contractVersion: SHARED_NODE_TRANSPORT_CONTRACT_VERSION,
      commandId,
      acknowledged: true,
      leaseGeneration,
    };
  }

  async renewLease(
    nodeId: string,
    commandId: string,
    leaseToken: string,
    leaseGeneration: number,
    request: SharedNodeSignedRequest,
  ) {
    await this.authenticateNode(nodeId, request);
    const renewed = await this.options.commandOutbox.renew({
      nodeId,
      commandId,
      leaseToken,
      leaseGeneration,
      now: this.now().toISOString(),
      leaseMs: this.commandLeaseMs,
      maxLifetimeMs: this.commandMaxLifetimeMs,
    });
    return {
      contractVersion: SHARED_NODE_TRANSPORT_CONTRACT_VERSION,
      leaseGeneration,
      ...renewed,
    };
  }

  async started(
    nodeId: string,
    input: {
      serviceId: string;
      assignmentId: string;
      endpoint: { host: string; port: number };
    },
    request: SharedNodeSignedRequest,
  ) {
    await this.authenticateNode(nodeId, request);
    const reservation = await this.options.ingressRepository?.findByAssignment(
      nodeId,
      input.assignmentId,
    );
    if (
      !reservation ||
      reservation.serviceId !== input.serviceId ||
      reservation.host !== input.endpoint.host ||
      reservation.port !== input.endpoint.port
    ) {
      throw new SharedNodeTransportError("invalid_request");
    }
    await this.options.scheduler.reportStarted({ nodeId, ...input });
    return {
      contractVersion: SHARED_NODE_TRANSPORT_CONTRACT_VERSION,
      endpoint: { host: reservation.host, port: reservation.port },
    };
  }

  async stoppedAndSynced(
    nodeId: string,
    input: {
      serviceId: string;
      assignmentId: string;
      commandId: string;
      leaseToken: string;
      leaseGeneration: number;
      workspace: Omit<SharedWorkspace, "objectPrefix">;
    },
    request: SharedNodeSignedRequest,
  ) {
    await this.authenticateNode(nodeId, request);
    const command = await this.leasedWorkspaceCommand(
      nodeId,
      {
        contractVersion: SHARED_NODE_WORKSPACE_CONTRACT_VERSION,
        commandId: input.commandId,
        assignmentId: input.assignmentId,
        leaseToken: input.leaseToken,
        leaseGeneration: input.leaseGeneration,
      },
      "workspace.stop_and_sync",
    );
    if (
      command.serviceId !== input.serviceId ||
      input.workspace.revision !== command.workspace.revision + 1
    ) {
      throw new SharedNodeTransportError("workspace_grant_denied");
    }
    if (this.options.workspaceManifestRepository) {
      await this.options.workspaceManifestRepository.markPublished({
        serviceId: input.serviceId,
        assignmentId: input.assignmentId,
        revision: input.workspace.revision,
        manifestSha256: input.workspace.sha256,
      });
    }
    await this.options.scheduler.reportStoppedAndSynced({ nodeId, ...input });
    await this.options.ingressRepository?.release(
      nodeId,
      input.assignmentId,
      this.now().toISOString(),
    );
    return {
      contractVersion: SHARED_NODE_TRANSPORT_CONTRACT_VERSION,
      released: true,
    };
  }

  async sweep(at = this.now().toISOString()) {
    const now = new Date(at).toISOString();
    const redelivered = await this.options.commandOutbox.requeueExpired(now);
    await this.options.scheduler.sweepStaleNodes(undefined, new Date(now));
    return { redelivered };
  }

  async isRegistered(nodeId: string) {
    return await this.options.scheduler.hasNode(nodeId);
  }

  async workspaceRestoreGrant(
    nodeId: string,
    input: SharedWorkspaceGrantRequest,
    request: SharedNodeSignedRequest,
  ): Promise<SharedWorkspaceGrantResponse> {
    await this.authenticateNode(nodeId, request);
    const command = await this.leasedWorkspaceCommand(
      nodeId,
      input,
      "workspace.restore_and_start",
    );
    const manifests = this.requireWorkspaceManifests();
    const stage = input.stage ?? "manifest";
    if (stage === "manifest") {
      if (
        input.keys?.length || input.manifest || input.manifestSha256
      ) {
        throw new SharedNodeTransportError("invalid_request");
      }
      const record = await manifests.find(
        command.serviceId,
        command.workspace.revision,
      );
      if (!record || record.status !== "published") {
        throw new SharedNodeTransportError("workspace_grant_denied");
      }
      return await this.grants([
        manifestObjectKey(
          command.workspace.objectPrefix,
          command.workspace.revision,
        ),
      ], "GET");
    }
    if (
      stage !== "blobs" || !input.keys?.length ||
      input.keys.length > maxWorkspaceBlobCount || input.manifest ||
      input.manifestSha256
    ) {
      throw new SharedNodeTransportError("invalid_request");
    }
    const runtimeContent = await this.selectedRuntimeContent(command);
    if (command.workspace.revision === 0) {
      if (
        !runtimeContent || input.keys.length !== 1 ||
        input.keys[0] !== runtimeContent.key
      ) {
        throw new SharedNodeTransportError("workspace_grant_denied");
      }
      return await this.grants([runtimeContent.key], "GET");
    }
    const record = await manifests.find(
      command.serviceId,
      command.workspace.revision,
    );
    if (!record || record.status !== "published") {
      throw new SharedNodeTransportError("workspace_grant_denied");
    }
    const permitted = new Set(manifestBlobKeys(record.manifest));
    if (runtimeContent) permitted.add(runtimeContent.key);
    const requested = uniqueKeys(input.keys);
    if (requested.some((key) => !permitted.has(key))) {
      throw new SharedNodeTransportError("workspace_grant_denied");
    }
    return await this.grants(requested, "GET");
  }

  async workspaceSyncGrant(
    nodeId: string,
    input: SharedWorkspaceGrantRequest,
    request: SharedNodeSignedRequest,
  ): Promise<SharedWorkspaceGrantResponse> {
    await this.authenticateNode(nodeId, request);
    const command = await this.leasedWorkspaceCommand(
      nodeId,
      input,
      "workspace.stop_and_sync",
    );
    if (!input.manifest || !input.manifestSha256) {
      throw new SharedNodeTransportError("invalid_request");
    }
    if (input.stage || input.keys?.length) {
      throw new SharedNodeTransportError("invalid_request");
    }
    const runtimeContent = await this.selectedRuntimeContent(command);
    await validateWorkspaceManifestDescriptor(
      input.manifest,
      command,
      input.manifestSha256,
      runtimeContent,
    );
    const manifests = this.requireWorkspaceManifests();
    const record = await manifests.prepare({
      serviceId: command.serviceId,
      accountId: command.accountId,
      assignmentId: command.assignmentId,
      commandId: command.commandId,
      revision: input.manifest.revision,
      manifest: clone(input.manifest),
      manifestSha256: input.manifestSha256,
      status: "draft",
      createdAt: this.now().toISOString(),
    });
    const grants: string[] = [];
    for (const descriptor of manifestBlobDescriptors(record.manifest)) {
      if (runtimeContent && sameDescriptor(descriptor, runtimeContent)) {
        continue;
      }
      const existing = await manifests.findPublishedBlob(
        command.serviceId,
        descriptor.key,
      );
      if (existing && sameDescriptor(existing, descriptor)) {
        continue;
      }
      if (
        descriptor !== record.manifest.content &&
        !descriptor.key.startsWith(
          `${
            validWorkspacePrefix(command.workspace.objectPrefix)
          }/revisions/${record.manifest.revision}/`,
        )
      ) {
        // References to prior revision layers are legal only when the exact
        // immutable descriptor is already published for this service.
        throw new SharedNodeTransportError("workspace_grant_denied");
      }
      grants.push(descriptor.key);
    }
    return await this.grants(grants, "PUT");
  }

  async workspacePublishGrant(
    nodeId: string,
    input: SharedWorkspaceGrantRequest,
    request: SharedNodeSignedRequest,
  ): Promise<SharedWorkspaceGrantResponse> {
    await this.authenticateNode(nodeId, request);
    const command = await this.leasedWorkspaceCommand(
      nodeId,
      input,
      "workspace.stop_and_sync",
    );
    if (!input.manifest || !input.manifestSha256) {
      throw new SharedNodeTransportError("invalid_request");
    }
    if (input.stage || input.keys?.length) {
      throw new SharedNodeTransportError("invalid_request");
    }
    const runtimeContent = await this.selectedRuntimeContent(command);
    await validateWorkspaceManifestDescriptor(
      input.manifest,
      command,
      input.manifestSha256,
      runtimeContent,
    );
    const record = await this.requireWorkspaceManifests().find(
      command.serviceId,
      input.manifest.revision,
    );
    if (
      !record || record.status !== "draft" ||
      record.commandId !== command.commandId ||
      record.assignmentId !== command.assignmentId ||
      record.manifestSha256 !== input.manifestSha256 ||
      JSON.stringify(record.manifest) !== JSON.stringify(input.manifest)
    ) {
      throw new SharedNodeTransportError("workspace_grant_denied");
    }
    return await this.grants([
      manifestObjectKey(
        command.workspace.objectPrefix,
        input.manifest.revision,
      ),
    ], "PUT");
  }

  private async leasedWorkspaceCommand(
    nodeId: string,
    input: SharedWorkspaceGrantRequest,
    expectedKind: SharedNodeCommand["kind"],
  ) {
    if (
      input.contractVersion !== SHARED_NODE_WORKSPACE_CONTRACT_VERSION ||
      !validIdentifier(input.commandId) ||
      !validIdentifier(input.assignmentId) ||
      !validLeaseToken(input.leaseToken) ||
      !Number.isSafeInteger(input.leaseGeneration) ||
      input.leaseGeneration < 1
    ) {
      throw new SharedNodeTransportError("invalid_request");
    }
    const command = await this.options.commandOutbox.leased({
      nodeId,
      commandId: input.commandId,
      leaseToken: input.leaseToken,
      leaseGeneration: input.leaseGeneration,
      now: this.now().toISOString(),
    });
    if (
      command.kind !== expectedKind ||
      command.assignmentId !== input.assignmentId ||
      command.nodeId !== nodeId
    ) {
      throw new SharedNodeTransportError("workspace_grant_denied");
    }
    return command;
  }

  private requireWorkspaceManifests() {
    if (
      !this.options.workspaceSigner || !this.options.workspaceManifestRepository
    ) {
      throw new SharedNodeTransportError("unavailable");
    }
    return this.options.workspaceManifestRepository;
  }

  private async selectedRuntimeContent(command: SharedNodeCommand) {
    const selected = command.runtimeContent;
    if (!selected) return undefined;
    if (
      !this.options.runtimeContentGrantAuthority ||
      !validateRuntimeContentDescriptor(selected, command)
    ) {
      throw new SharedNodeTransportError("workspace_grant_denied");
    }
    const allowed = await this.options.runtimeContentGrantAuthority
      .authorizeNodeRestore({
        accountId: command.accountId,
        serviceId: command.serviceId,
        deploymentId: selected.deploymentId,
        manifestSha256: selected.manifestSha256,
        content: {
          key: selected.key,
          sha256: selected.sha256,
          compressedSize: selected.compressedSize,
          logicalSize: selected.logicalSize,
          paths: selected.paths,
        },
      });
    if (!allowed) throw new SharedNodeTransportError("workspace_grant_denied");
    return selected;
  }

  private async grants(
    keys: readonly string[],
    method: "GET" | "PUT",
  ): Promise<SharedWorkspaceGrantResponse> {
    const signer = this.options.workspaceSigner;
    if (!signer) throw new SharedNodeTransportError("unavailable");
    const seconds = this.workspaceGrantTtlMs / 1_000;
    const grants = await Promise.all(keys.map(async (key) => {
      const signed = await signer.presign(key, method, seconds);
      if (signed.key !== key || signed.method !== method) {
        throw new SharedNodeTransportError("unavailable");
      }
      return {
        key: signed.key,
        method: signed.method,
        url: signed.url,
        expiresAt: signed.expiresAt,
        ...(signed.headers ? { headers: signed.headers } : {}),
      };
    }));
    return {
      contractVersion: SHARED_NODE_WORKSPACE_CONTRACT_VERSION,
      grants,
    };
  }

  async endpointForService(serviceId: string) {
    const reservation = await this.options.ingressRepository
      ?.findActiveByService(
        serviceId,
      );
    return reservation && {
      host: reservation.host,
      port: reservation.port,
    } satisfies SharedNodePublicEndpoint;
  }

  private async authenticateNode(
    nodeId: string,
    request: SharedNodeSignedRequest,
  ) {
    const credential = parseNodeCredential(request.authorization);
    if (!credential || credential.nodeId !== nodeId) {
      throw new SharedNodeTransportError("node_conflict");
    }
    const record = await this.options.credentialRepository.findCredential(
      nodeId,
    );
    if (
      !record ||
      Date.parse(record.expiresAt) <= this.now().getTime() ||
      !constantTimeEqual(await sha256(credential.token), record.tokenHash)
    ) {
      throw new SharedNodeTransportError("unauthorized");
    }
    await this.authenticateSigned(request, credential.token, nodeId);
  }

  private async authenticateBootstrap(
    request: SharedNodeSignedRequest,
    credential: string,
    nodeId: string,
  ) {
    await this.authenticateSigned(request, credential, `bootstrap:${nodeId}`);
  }

  private async authenticateSigned(
    request: SharedNodeSignedRequest,
    secret: string,
    nonceScope: string,
  ) {
    const timestamp = Number(request.timestamp);
    const bodyHash = await sha256(request.body);
    if (
      !request.timestamp || !request.nonce || !request.signature ||
      !request.bodyHash || !Number.isSafeInteger(timestamp) ||
      !constantTimeEqual(bodyHash, request.bodyHash)
    ) {
      throw new SharedNodeTransportError("unauthorized");
    }
    if (
      Math.abs(this.now().getTime() - timestamp) > this.requestClockSkewMs
    ) {
      throw new SharedNodeTransportError("stale_request");
    }
    const expected = await signSharedNodeRequest(secret, request);
    if (!constantTimeEqual(expected, request.signature)) {
      throw new SharedNodeTransportError("invalid_signature");
    }
    const replay = await this.options.credentialRepository.claimNonce({
      nodeId: nonceScope,
      nonce: request.nonce,
      fingerprint: expected,
      expiresAt: new Date(timestamp + this.requestClockSkewMs).toISOString(),
    });
    if (replay === "replayed") {
      throw new SharedNodeTransportError("replay_detected");
    }
  }
}

function validateHeartbeat(value: SharedNodeHeartbeat) {
  if (
    value.contractVersion !== SHARED_NODE_TRANSPORT_CONTRACT_VERSION ||
    !["ready", "draining"].includes(value.status) ||
    !nonNegativeSafeInteger(value.capacity.freeWorkspaceGiB) ||
    !nonNegativeSafeInteger(value.capacity.allocatableMemoryMiB) ||
    !nonNegativeSafeInteger(value.capacity.allocatableSharedCpu) ||
    !nonNegativeSafeInteger(value.capacity.activeContainerCount) ||
    typeof value.agentVersion !== "string" ||
    !value.agentVersion ||
    value.agentVersion.length > 128 ||
    !value.ingress
  ) {
    throw new SharedNodeTransportError("invalid_request");
  }
  validateIngressEndpoint({ host: value.ingress.host }, true);
}

function validateIngressEndpoint(
  value: { host: string; port?: number },
  allowUnassignedPort = false,
) {
  if (
    typeof value.host !== "string" ||
    !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(value.host) ||
    (value.port !== undefined &&
      (!Number.isSafeInteger(value.port) ||
        value.port < 1024 ||
        value.port > 65535)) ||
    (!allowUnassignedPort && value.port === undefined)
  ) {
    throw new SharedNodeTransportError("invalid_request");
  }
}

function ingressPortCandidates(min: number, max: number) {
  const size = max - min + 1;
  const start = min + crypto.getRandomValues(new Uint32Array(1))[0] % size;
  return [...Array(size)].map((_, index) => min + (start - min + index) % size);
}

function nonNegativeSafeInteger(value: unknown) {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function ingressKey(host: string, port: number) {
  return `${host.toLowerCase()}:${port}`;
}

function workspaceManifestRecordKey(serviceId: string, revision: number) {
  return `${serviceId}:${revision}`;
}

function manifestObjectKey(prefix: string, revision: number) {
  return `${validWorkspacePrefix(prefix)}/revisions/${revision}/manifest.json`;
}

function validWorkspacePrefix(prefix: string) {
  const match = /^shared-hosting\/([^/]+)\/([^/]+)\/$/.exec(prefix);
  if (!match || !validIdentifier(match[1]) || !validIdentifier(match[2])) {
    throw new SharedNodeTransportError("workspace_grant_denied");
  }
  return prefix.slice(0, -1);
}

async function validateWorkspaceManifestDescriptor(
  manifest: SharedWorkspaceManifestDescriptor,
  command: SharedNodeCommand,
  manifestSha256: string,
  runtimeContent?: SharedNodeCommand["runtimeContent"],
) {
  if (!isWorkspaceManifestDescriptor(manifest)) {
    throw new SharedNodeTransportError("workspace_grant_denied");
  }
  const prefix = validWorkspacePrefix(command.workspace.objectPrefix);
  if (
    prefix !== `shared-hosting/${command.accountId}/${command.serviceId}` ||
    manifest.schemaVersion !== 2 ||
    manifest.serviceId !== command.serviceId ||
    manifest.assignmentId !== command.assignmentId ||
    manifest.revision !== command.workspace.revision + 1 ||
    !Number.isSafeInteger(manifest.logicalSize) || manifest.logicalSize < 0 ||
    manifest.logicalSize > maxWorkspaceBytes ||
    !validSha256(manifest.manifestHash) ||
    !validSha256(manifest.aggregateSha256) ||
    manifest.manifestHash !== manifest.aggregateSha256 ||
    !validSha256(manifestSha256) ||
    !Number.isFinite(Date.parse(manifest.createdAt))
  ) {
    throw new SharedNodeTransportError("workspace_grant_denied");
  }
  const descriptors = manifestBlobDescriptors(manifest);
  if (
    !manifest.content || !descriptors.length ||
    descriptors.length > maxWorkspaceBlobCount
  ) {
    throw new SharedNodeTransportError("workspace_grant_denied");
  }
  const keys = new Set<string>();
  const paths = new Set<string>();
  let logicalSize = 0;
  let compressedSize = 0;
  for (const descriptor of descriptors) {
    if (
      !validateBlobDescriptor(descriptor) ||
      keys.has(descriptor.key) ||
      descriptor.paths.some((path) => paths.has(path))
    ) {
      throw new SharedNodeTransportError("workspace_grant_denied");
    }
    keys.add(descriptor.key);
    for (const path of descriptor.paths) paths.add(path);
    logicalSize += descriptor.logicalSize;
    compressedSize += descriptor.compressedSize;
  }
  if (
    logicalSize !== manifest.logicalSize ||
    compressedSize > maxWorkspaceBytes ||
    paths.size > maxWorkspacePathCount
  ) {
    throw new SharedNodeTransportError("workspace_grant_denied");
  }
  const contentIsCompilerSelected = Boolean(
    manifest.content && runtimeContent &&
      sameDescriptor(manifest.content, runtimeContent),
  );
  if (
    manifest.content &&
    manifest.content.key !==
      `${prefix}/content/${manifest.content.sha256}.tar.zst` &&
    !contentIsCompilerSelected
  ) {
    throw new SharedNodeTransportError("workspace_grant_denied");
  }
  if (
    manifest.content &&
    !manifest.content.paths.every(isContentPath)
  ) {
    throw new SharedNodeTransportError("workspace_grant_denied");
  }
  if (
    manifest.config &&
    !new RegExp(
      `^${escapeRegExp(prefix)}/revisions/([0-9]+)/config\\.tar\\.zst$`,
    ).test(manifest.config.key)
  ) {
    throw new SharedNodeTransportError("workspace_grant_denied");
  }
  if (
    manifest.config &&
    !manifest.config.paths.every(isConfigPath)
  ) {
    throw new SharedNodeTransportError("workspace_grant_denied");
  }
  for (const descriptor of manifest.world) {
    if (
      !new RegExp(
        `^${
          escapeRegExp(prefix)
        }/revisions/([0-9]+)/world/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\\.tar\\.zst$`,
      ).test(descriptor.key)
    ) {
      throw new SharedNodeTransportError("workspace_grant_denied");
    }
    if (!descriptor.paths.every(isWorldPath)) {
      throw new SharedNodeTransportError("workspace_grant_denied");
    }
  }
  if (
    await aggregateManifestDescriptors(manifest) !== manifest.aggregateSha256
  ) {
    throw new SharedNodeTransportError("workspace_grant_denied");
  }
}

function manifestBlobDescriptors(manifest: SharedWorkspaceManifestDescriptor) {
  return [
    ...(manifest.content ? [manifest.content] : []),
    ...(manifest.config ? [manifest.config] : []),
    ...manifest.world,
  ];
}

function manifestBlobKeys(manifest: SharedWorkspaceManifestDescriptor) {
  return manifestBlobDescriptors(manifest).map((descriptor) => descriptor.key);
}

function isWorkspaceManifestDescriptor(
  value: unknown,
): value is SharedWorkspaceManifestDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  return Array.isArray(manifest.world) &&
    manifest.world.every(isWorkspaceBlobDescriptor) &&
    (manifest.content === undefined ||
      isWorkspaceBlobDescriptor(manifest.content)) &&
    (manifest.config === undefined ||
      isWorkspaceBlobDescriptor(manifest.config));
}

function isWorkspaceBlobDescriptor(
  value: unknown,
): value is SharedWorkspaceBlobDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const descriptor = value as Record<string, unknown>;
  return typeof descriptor.key === "string" &&
    typeof descriptor.sha256 === "string" &&
    typeof descriptor.compressedSize === "number" &&
    typeof descriptor.logicalSize === "number" &&
    Array.isArray(descriptor.paths) &&
    descriptor.paths.every((path) => typeof path === "string");
}

function validateBlobDescriptor(value: SharedWorkspaceBlobDescriptor) {
  return validSha256(value.sha256) &&
    Number.isSafeInteger(value.compressedSize) && value.compressedSize > 0 &&
    value.compressedSize <= maxWorkspaceBlobBytes &&
    Number.isSafeInteger(value.logicalSize) && value.logicalSize >= 0 &&
    value.logicalSize <= maxWorkspaceBytes &&
    value.paths.length <= maxWorkspacePathCount &&
    value.paths.every(validWorkspacePath);
}

function validateRuntimeContentDescriptor(
  value: NonNullable<SharedNodeCommand["runtimeContent"]>,
  command: SharedNodeCommand,
) {
  const prefix =
    `shared-hosting/${command.accountId}/${command.serviceId}/compiler-content/`;
  return validIdentifier(value.deploymentId) &&
    validSha256(value.manifestSha256) &&
    validateBlobDescriptor(value) &&
    value.key.startsWith(prefix) && value.key.endsWith(".tar.zst") &&
    value.paths.includes(".xmcl/runtime.json") &&
    value.paths.includes(".xmcl/launch.sh") &&
    value.paths.every(isContentPath);
}

async function aggregateManifestDescriptors(
  manifest: SharedWorkspaceManifestDescriptor,
) {
  let value = "";
  for (const descriptor of manifestBlobDescriptors(manifest)) {
    value +=
      `${descriptor.key}\0${descriptor.sha256}\0${descriptor.compressedSize}:${descriptor.logicalSize}\0`;
    for (const path of descriptor.paths) value += `${path}\0`;
    value += "\n";
  }
  return await sha256(value);
}

function validWorkspacePath(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 && value.length <= 1_024 && !value.startsWith("/") &&
    !value.includes("\\") &&
    value.split("/").every((part) =>
      part.length > 0 && part !== "." && part !== ".."
    );
}

function isWorldPath(path: string) {
  return path === "world" || path.startsWith("world/") ||
    path === "world_nether" || path.startsWith("world_nether/") ||
    path === "world_the_end" || path.startsWith("world_the_end/");
}

function isConfigPath(path: string) {
  return path === "config" || path.startsWith("config/") ||
    path === "defaultconfigs" || path.startsWith("defaultconfigs/");
}

function isContentPath(path: string) {
  return !isWorldPath(path) && !isConfigPath(path);
}

function validIdentifier(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function validLeaseToken(value: string) {
  return /^[A-Za-z0-9-]{16,128}$/.test(value);
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function uniqueKeys(values: readonly string[]) {
  if (
    values.some((value) => typeof value !== "string") ||
    new Set(values).size !== values.length
  ) {
    throw new SharedNodeTransportError("invalid_request");
  }
  return [...values];
}

function sameDescriptor(
  left: SharedWorkspaceBlobDescriptor,
  right: SharedWorkspaceBlobDescriptor,
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function signSharedNodeRequest(
  secret: string,
  request: Pick<
    SharedNodeSignedRequest,
    "method" | "path" | "body" | "timestamp" | "nonce"
  >,
) {
  const bodyHash = await sha256(request.body);
  const payload = [
    request.method.toUpperCase(),
    request.path,
    request.timestamp ?? "",
    request.nonce ?? "",
    bodyHash,
  ].join("\n");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(
    await crypto.subtle.sign("HMAC", key, encoder.encode(payload)),
  );
}

function parseNodeCredential(value?: string) {
  const match = /^SharedNode ([^.]+\.[a-f0-9]+)$/i.exec(value ?? "");
  if (!match) return undefined;
  return { token: match[1], nodeId: match[1].slice(0, match[1].indexOf(".")) };
}

export function hashSharedNodeToken(value: string) {
  return sha256(value);
}

async function sha256(value: string) {
  return bytesToHex(
    await crypto.subtle.digest("SHA-256", encoder.encode(value)),
  );
}

function bytesToHex(value: ArrayBuffer | Uint8Array) {
  return [...new Uint8Array(value)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i += 1) {
    difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return difference === 0;
}
