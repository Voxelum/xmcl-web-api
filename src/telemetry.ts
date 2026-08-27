import type { Db, MongoCollection } from "./db.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCOUNT_ID = /^acct_[A-Za-z0-9_-]{1,128}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const TELEMETRY_RETENTION_SECONDS = 90 * 24 * 60 * 60;
const AI_AUDIT_RETENTION_SECONDS = 90 * 24 * 60 * 60;

export const MULTIPLAYER_ATTEMPTS_COLLECTION = "xmcl_multiplayer_attempts";
export const MULTIPLAYER_ADMISSIONS_COLLECTION = "xmcl_multiplayer_admissions";
export const AI_AUDIT_EVENTS_COLLECTION = "xmcl_ai_audit_events";
export const MAX_MULTIPLAYER_TELEMETRY_ATTEMPTS = 50;
export const MAX_MULTIPLAYER_TELEMETRY_BODY_BYTES = 64 * 1024;

export type P2pFailedStage =
  | "signaling_socket"
  | "peer_created"
  | "remote_description"
  | "ice_gathering"
  | "ice_connection"
  | "metadata_channel"
  | "minecraft_bridge";
export type P2pAttemptKind =
  | "peer_connection"
  | "signaling_socket"
  | "minecraft_bridge";
export type P2pTerminalOutcome =
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "closed";
export type P2pFailureCode =
  | "signaling_open_failed"
  | "signaling_closed"
  | "signaling_state_invalid"
  | "remote_description_invalid"
  | "ice_gathering_failed"
  | "ice_connection_failed"
  | "ice_timeout"
  | "data_channel_failed"
  | "metadata_timeout"
  | "bridge_bind_failed"
  | "bridge_connect_failed"
  | "peer_closed"
  | "launcher_shutdown"
  | "unknown";

export interface LauncherP2pAttempt {
  schemaVersion: 1;
  attemptId: string;
  roomSessionId?: string;
  turnSessionId?: string;
  deviceId: string;
  launcherSessionId: string;
  source: "launcher";
  occurredAt: string;
  kind: P2pAttemptKind;
  mode: "official_room" | "manual_offer";
  role: "master" | "member";
  outcome: P2pTerminalOutcome;
  failedStage?: P2pFailedStage;
  failureCode?: P2pFailureCode;
  route?: "unknown" | "direct" | "relay";
  localCandidateType?: "host" | "srflx" | "prflx" | "relay";
  remoteCandidateType?: "host" | "srflx" | "prflx" | "relay";
  networkProtocol?: "udp" | "tcp";
  retry: number;
  launcherVersion: string;
  launcherBuild: string;
  durationMs: number;
}

export interface StoredLauncherP2pAttempt extends LauncherP2pAttempt {
  accountId: string;
  receivedAt: Date;
}

export interface LauncherP2pAttemptBatch {
  expectedAccountId: string;
  attempts: LauncherP2pAttempt[];
}

export type RoomAdmissionFailureCode =
  | "room_not_found"
  | "room_full"
  | "room_closed"
  | "unknown";

export interface RoomAdmissionTelemetry {
  schemaVersion: 1;
  admissionId: string;
  accountId: string;
  roomSessionId?: string;
  source: "signaling";
  occurredAt: string;
  receivedAt: Date;
  role: "master" | "member";
  outcome: "succeeded" | "failed";
  failureCode?: RoomAdmissionFailureCode;
}

export interface AiAuditEvent {
  requestId: string;
  accountId: string;
  provider: string;
  model: string;
  outcome: "succeeded" | "failed";
  statusClass: "2xx" | "4xx" | "5xx";
  failureCode?:
    | "upstream_rejected"
    | "provider_unavailable"
    | "accounting_failed";
  promptTokens?: number;
  cachedPromptTokens?: number;
  completionTokens?: number;
  billedUnits?: number;
  durationMs: number;
  receivedAt: Date;
}

export interface LauncherP2pAttemptRepository {
  record(
    attempt: StoredLauncherP2pAttempt,
  ): Promise<"recorded" | "duplicate">;
}

export interface RoomAdmissionTelemetryRepository {
  record(
    admission: RoomAdmissionTelemetry,
  ): Promise<"recorded" | "duplicate">;
}

export interface AiAuditRepository {
  record(event: AiAuditEvent): Promise<"recorded" | "duplicate">;
}

function isDuplicateKey(error: unknown) {
  return typeof error === "object" && error !== null &&
    (
      ("code" in error && Number(error.code) === 11_000) ||
      (error instanceof Error && /duplicate key/i.test(error.message))
    );
}

function writableCollection(
  collection: MongoCollection,
  collectionName: string,
) {
  if (!collection.insertOne) {
    throw new Error(`${collectionName} does not support insertOne`);
  }
  if (!collection.createIndex) {
    throw new Error(`${collectionName} does not support index creation`);
  }
  return collection as
    & Required<
      Pick<MongoCollection, "insertOne" | "createIndex">
    >
    & MongoCollection;
}

const attemptIndexPromises = new WeakMap<object, Promise<void>>();
const admissionIndexPromises = new WeakMap<object, Promise<void>>();
const aiIndexPromises = new WeakMap<object, Promise<void>>();
let attemptIndexesReady = false;
let admissionIndexesReady = false;
let aiIndexesReady = false;

export async function ensureLauncherP2pAttemptIndexes(
  collection: MongoCollection,
) {
  if (attemptIndexesReady) return;
  const writable = writableCollection(
    collection,
    MULTIPLAYER_ATTEMPTS_COLLECTION,
  );
  let promise = attemptIndexPromises.get(writable);
  if (!promise) {
    promise = Promise.all([
      writable.createIndex(
        { accountId: 1, receivedAt: -1 },
        { name: "p2p_attempt_account_received" },
      ),
      writable.createIndex(
        { outcome: 1, failureCode: 1, receivedAt: -1 },
        { name: "p2p_attempt_outcome_failure_received" },
      ),
      writable.createIndex(
        { turnSessionId: 1 },
        { name: "p2p_attempt_turn_session", sparse: true },
      ),
      writable.createIndex(
        { roomSessionId: 1 },
        { name: "p2p_attempt_room_session", sparse: true },
      ),
      writable.createIndex(
        { receivedAt: 1 },
        {
          name: "p2p_attempt_received_expiry",
          expireAfterSeconds: TELEMETRY_RETENTION_SECONDS,
        },
      ),
    ]).then(() => {
      attemptIndexesReady = true;
    }).catch((error) => {
      attemptIndexPromises.delete(writable);
      throw error;
    });
    attemptIndexPromises.set(writable, promise);
  }
  await promise;
}

export async function ensureRoomAdmissionTelemetryIndexes(
  collection: MongoCollection,
) {
  if (admissionIndexesReady) return;
  const writable = writableCollection(
    collection,
    MULTIPLAYER_ADMISSIONS_COLLECTION,
  );
  let promise = admissionIndexPromises.get(writable);
  if (!promise) {
    promise = Promise.all([
      writable.createIndex(
        { accountId: 1, receivedAt: -1 },
        { name: "room_admission_account_received" },
      ),
      writable.createIndex(
        { roomSessionId: 1 },
        { name: "room_admission_room_session", sparse: true },
      ),
      writable.createIndex(
        { receivedAt: 1 },
        {
          name: "room_admission_received_expiry",
          expireAfterSeconds: TELEMETRY_RETENTION_SECONDS,
        },
      ),
    ]).then(() => {
      admissionIndexesReady = true;
    }).catch((error) => {
      admissionIndexPromises.delete(writable);
      throw error;
    });
    admissionIndexPromises.set(writable, promise);
  }
  await promise;
}

export async function ensureAiAuditIndexes(collection: MongoCollection) {
  if (aiIndexesReady) return;
  const writable = writableCollection(collection, AI_AUDIT_EVENTS_COLLECTION);
  let promise = aiIndexPromises.get(writable);
  if (!promise) {
    promise = Promise.all([
      writable.createIndex(
        { accountId: 1, receivedAt: -1 },
        { name: "ai_audit_account_received" },
      ),
      writable.createIndex(
        { requestId: 1, receivedAt: -1 },
        { name: "ai_audit_request_received" },
      ),
      writable.createIndex(
        { receivedAt: 1 },
        {
          name: "ai_audit_received_expiry",
          expireAfterSeconds: AI_AUDIT_RETENTION_SECONDS,
        },
      ),
    ]).then(() => {
      aiIndexesReady = true;
    }).catch((error) => {
      aiIndexPromises.delete(writable);
      throw error;
    });
    aiIndexPromises.set(writable, promise);
  }
  await promise;
}

function attemptDocumentId(accountId: string, attemptId: string) {
  return `${accountId}:${attemptId}`;
}

export class MongoLauncherP2pAttemptRepository
  implements LauncherP2pAttemptRepository {
  private readonly collection: MongoCollection;

  constructor(db: Db) {
    this.collection = db.collection(MULTIPLAYER_ATTEMPTS_COLLECTION);
  }

  async record(attempt: StoredLauncherP2pAttempt) {
    await ensureLauncherP2pAttemptIndexes(this.collection);
    try {
      await writableCollection(this.collection, MULTIPLAYER_ATTEMPTS_COLLECTION)
        .insertOne({
          _id: attemptDocumentId(attempt.accountId, attempt.attemptId),
          ...attempt,
        });
      return "recorded" as const;
    } catch (error) {
      if (isDuplicateKey(error)) return "duplicate" as const;
      throw error;
    }
  }
}

export class MongoRoomAdmissionTelemetryRepository
  implements RoomAdmissionTelemetryRepository {
  private readonly collection: MongoCollection;

  constructor(db: Db) {
    this.collection = db.collection(MULTIPLAYER_ADMISSIONS_COLLECTION);
  }

  async record(admission: RoomAdmissionTelemetry) {
    await ensureRoomAdmissionTelemetryIndexes(this.collection);
    try {
      await writableCollection(
        this.collection,
        MULTIPLAYER_ADMISSIONS_COLLECTION,
      ).insertOne({ _id: admission.admissionId, ...admission });
      return "recorded" as const;
    } catch (error) {
      if (isDuplicateKey(error)) return "duplicate" as const;
      throw error;
    }
  }
}

export class MongoAiAuditRepository implements AiAuditRepository {
  private readonly collection: MongoCollection;

  constructor(db: Db) {
    this.collection = db.collection(AI_AUDIT_EVENTS_COLLECTION);
  }

  async record(event: AiAuditEvent) {
    await ensureAiAuditIndexes(this.collection);
    try {
      await writableCollection(this.collection, AI_AUDIT_EVENTS_COLLECTION)
        .insertOne({ _id: event.requestId, ...event });
      return "recorded" as const;
    } catch (error) {
      if (isDuplicateKey(error)) return "duplicate" as const;
      throw error;
    }
  }
}

const failedStages = new Set<P2pFailedStage>([
  "signaling_socket",
  "peer_created",
  "remote_description",
  "ice_gathering",
  "ice_connection",
  "metadata_channel",
  "minecraft_bridge",
]);
const kinds = new Set<P2pAttemptKind>([
  "peer_connection",
  "signaling_socket",
  "minecraft_bridge",
]);
const outcomes = new Set<P2pTerminalOutcome>([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "closed",
]);
const failureCodes = new Set<P2pFailureCode>([
  "signaling_open_failed",
  "signaling_closed",
  "signaling_state_invalid",
  "remote_description_invalid",
  "ice_gathering_failed",
  "ice_connection_failed",
  "ice_timeout",
  "data_channel_failed",
  "metadata_timeout",
  "bridge_bind_failed",
  "bridge_connect_failed",
  "peer_closed",
  "launcher_shutdown",
  "unknown",
]);
const routes = new Set(["unknown", "direct", "relay"]);
const candidateTypes = new Set(["host", "srflx", "prflx", "relay"]);
const protocols = new Set(["udp", "tcp"]);

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function uuid(value: unknown) {
  return typeof value === "string" && UUID.test(value);
}

function optionalUuid(value: unknown) {
  return value === undefined || uuid(value);
}

function version(value: unknown) {
  return typeof value === "string" && VERSION.test(value);
}

function controlled<T extends string>(
  value: unknown,
  allowed: Set<T>,
): value is T {
  return typeof value === "string" && allowed.has(value as T);
}

function validOccurredAt(value: unknown, now: number) {
  if (typeof value !== "string" || value.length > 32) return false;
  const occurredAt = Date.parse(value);
  return Number.isFinite(occurredAt) &&
    occurredAt <= now + 5 * 60_000 &&
    occurredAt >= now - 91 * 24 * 60 * 60_000;
}

function failedStageMatchesKind(kind: unknown, stage: P2pFailedStage) {
  if (kind === "signaling_socket") return stage === "signaling_socket";
  if (kind === "minecraft_bridge") return stage === "minecraft_bridge";
  return kind === "peer_connection" &&
    (
      stage === "peer_created" ||
      stage === "remote_description" ||
      stage === "ice_gathering" ||
      stage === "ice_connection" ||
      stage === "metadata_channel"
    );
}

function failureCodeMatchesStage(
  stage: P2pFailedStage,
  code: P2pFailureCode,
) {
  if (
    code === "launcher_shutdown" ||
    code === "peer_closed" ||
    code === "unknown"
  ) {
    return stage !== "signaling_socket" || code !== "peer_closed";
  }
  if (stage === "signaling_socket") {
    return code === "signaling_open_failed" ||
      code === "signaling_closed";
  }
  if (stage === "remote_description") {
    return code === "signaling_state_invalid" ||
      code === "remote_description_invalid";
  }
  if (stage === "ice_gathering") return code === "ice_gathering_failed";
  if (stage === "ice_connection") {
    return code === "ice_connection_failed" ||
      code === "ice_timeout" ||
      code === "data_channel_failed";
  }
  if (stage === "metadata_channel") {
    return code === "metadata_timeout" ||
      code === "data_channel_failed";
  }
  if (stage === "minecraft_bridge") {
    return code === "bridge_bind_failed" ||
      code === "bridge_connect_failed";
  }
  return false;
}

export function parseLauncherP2pAttemptBatch(
  value: unknown,
  now = Date.now(),
): LauncherP2pAttemptBatch | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const body = value as Record<string, unknown>;
  if (
    !exactKeys(body, ["expectedAccountId", "attempts"]) ||
    typeof body.expectedAccountId !== "string" ||
    !ACCOUNT_ID.test(body.expectedAccountId) ||
    !Array.isArray(body.attempts) ||
    body.attempts.length === 0 ||
    body.attempts.length > MAX_MULTIPLAYER_TELEMETRY_ATTEMPTS
  ) {
    return;
  }
  const allowed = [
    "schemaVersion",
    "attemptId",
    "roomSessionId",
    "turnSessionId",
    "deviceId",
    "launcherSessionId",
    "source",
    "occurredAt",
    "kind",
    "mode",
    "role",
    "outcome",
    "failedStage",
    "failureCode",
    "route",
    "localCandidateType",
    "remoteCandidateType",
    "networkProtocol",
    "retry",
    "launcherVersion",
    "launcherBuild",
    "durationMs",
  ];
  const attempts: LauncherP2pAttempt[] = [];
  for (const value of body.attempts) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const attempt = value as Record<string, unknown>;
    const requiresFailureCode = attempt.outcome === "failed" ||
      attempt.outcome === "timed_out";
    const validFailureCode = controlled(attempt.failureCode, failureCodes) &&
      controlled(attempt.failedStage, failedStages) &&
      failureCodeMatchesStage(attempt.failedStage, attempt.failureCode);
    const succeeded = attempt.outcome === "succeeded";
    const coherentFailure = succeeded
      ? attempt.failedStage === undefined && attempt.failureCode === undefined
      : controlled(attempt.failedStage, failedStages) &&
        failedStageMatchesKind(attempt.kind, attempt.failedStage) &&
        (requiresFailureCode
          ? validFailureCode
          : attempt.failureCode === undefined ||
            validFailureCode);
    if (
      !exactKeys(attempt, allowed) || attempt.schemaVersion !== 1 ||
      !uuid(attempt.attemptId) || !optionalUuid(attempt.roomSessionId) ||
      !optionalUuid(attempt.turnSessionId) || !uuid(attempt.deviceId) ||
      !uuid(attempt.launcherSessionId) || attempt.source !== "launcher" ||
      !validOccurredAt(attempt.occurredAt, now) ||
      !controlled(attempt.kind, kinds) ||
      (attempt.mode !== "official_room" &&
        attempt.mode !== "manual_offer") ||
      (attempt.role !== "master" && attempt.role !== "member") ||
      !controlled(attempt.outcome, outcomes) ||
      !coherentFailure ||
      (attempt.route !== undefined && !controlled(attempt.route, routes)) ||
      (attempt.turnSessionId !== undefined &&
        (attempt.route !== "relay" ||
          attempt.localCandidateType !== "relay")) ||
      (attempt.localCandidateType !== undefined &&
        !controlled(attempt.localCandidateType, candidateTypes)) ||
      (attempt.remoteCandidateType !== undefined &&
        !controlled(attempt.remoteCandidateType, candidateTypes)) ||
      (attempt.networkProtocol !== undefined &&
        !controlled(attempt.networkProtocol, protocols)) ||
      !Number.isSafeInteger(attempt.retry) || Number(attempt.retry) < 0 ||
      Number(attempt.retry) > 100 || !version(attempt.launcherVersion) ||
      !version(attempt.launcherBuild) ||
      !Number.isSafeInteger(attempt.durationMs) ||
      Number(attempt.durationMs) < 0 ||
      Number(attempt.durationMs) > 24 * 60 * 60 * 1_000
    ) return;
    attempts.push(attempt as unknown as LauncherP2pAttempt);
  }
  return { expectedAccountId: body.expectedAccountId, attempts };
}
