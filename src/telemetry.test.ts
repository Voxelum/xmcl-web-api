import assert from "node:assert/strict";
import type { Db, MongoCollection } from "./db.ts";
import {
  AI_AUDIT_EVENTS_COLLECTION,
  type LauncherP2pAttempt,
  MongoAiAuditRepository,
  MongoLauncherP2pAttemptRepository,
  MongoRoomAdmissionTelemetryRepository,
  MULTIPLAYER_ADMISSIONS_COLLECTION,
  MULTIPLAYER_ATTEMPTS_COLLECTION,
  parseLauncherP2pAttemptBatch,
} from "./telemetry.ts";

class TelemetryCollection implements MongoCollection {
  readonly documents = new Map<string, Record<string, unknown>>();
  readonly indexes: Array<{
    keys: Record<string, 1 | -1>;
    options?: {
      expireAfterSeconds?: number;
      name?: string;
      sparse?: boolean;
    };
  }> = [];

  createIndex(
    keys: Record<string, 1 | -1>,
    options?: {
      expireAfterSeconds?: number;
      name?: string;
      sparse?: boolean;
    },
  ) {
    this.indexes.push({ keys, options });
    return Promise.resolve(options?.name);
  }

  insertOne(document: Record<string, unknown>) {
    const id = String(document._id);
    if (this.documents.has(id)) {
      return Promise.reject(Object.assign(new Error("duplicate key"), {
        code: 11_000,
      }));
    }
    this.documents.set(id, structuredClone(document));
    return Promise.resolve({ insertedId: id });
  }

  findOne(): Promise<null> {
    throw new Error("not used");
  }
  findOneAndUpdate(): Promise<null> {
    throw new Error("not used");
  }
  updateOne(): Promise<unknown> {
    throw new Error("not used");
  }
  replaceOne(): Promise<unknown> {
    throw new Error("not used");
  }
  deleteOne(): Promise<unknown> {
    throw new Error("not used");
  }
}

class TelemetryDb implements Db {
  readonly attempts = new TelemetryCollection();
  readonly admissions = new TelemetryCollection();
  readonly ai = new TelemetryCollection();

  collection(name: string) {
    if (name === MULTIPLAYER_ATTEMPTS_COLLECTION) return this.attempts;
    if (name === MULTIPLAYER_ADMISSIONS_COLLECTION) return this.admissions;
    if (name === AI_AUDIT_EVENTS_COLLECTION) return this.ai;
    throw new Error(`Unexpected collection ${name}`);
  }
}

function launcherAttempt(): LauncherP2pAttempt {
  return {
    schemaVersion: 1,
    attemptId: "33333333-3333-4333-8333-333333333333",
    roomSessionId: "44444444-4444-4444-8444-444444444444",
    turnSessionId: "55555555-5555-4555-8555-555555555555",
    deviceId: "66666666-6666-4666-8666-666666666666",
    launcherSessionId: "77777777-7777-4777-8777-777777777777",
    source: "launcher",
    occurredAt: "2026-08-27T12:00:00.000Z",
    kind: "peer_connection",
    mode: "official_room",
    role: "member",
    outcome: "failed",
    failedStage: "ice_connection",
    failureCode: "ice_connection_failed",
    route: "relay",
    localCandidateType: "relay",
    remoteCandidateType: "relay",
    networkProtocol: "udp",
    retry: 1,
    launcherVersion: "0.67.2",
    launcherBuild: "1469",
    durationMs: 12_345,
  };
}

function launcherBatch(attempts: unknown[]) {
  return { expectedAccountId: "acct_telemetry", attempts };
}

Deno.test("P2P attempt summaries accept only a terminal privacy-safe contract", () => {
  const now = Date.parse("2026-08-27T12:01:00.000Z");
  assert.deepEqual(
    parseLauncherP2pAttemptBatch(launcherBatch([launcherAttempt()]), now),
    launcherBatch([launcherAttempt()]),
  );
  const succeeded = {
    ...launcherAttempt(),
    outcome: "succeeded",
    failedStage: undefined,
    failureCode: undefined,
    turnSessionId: undefined,
    route: "direct",
  };
  assert.deepEqual(
    parseLauncherP2pAttemptBatch(launcherBatch([succeeded]), now),
    launcherBatch([succeeded]),
  );
  for (
    const [kind, failedStage] of [
      ["peer_connection", "metadata_channel"],
      ["signaling_socket", "signaling_socket"],
      ["minecraft_bridge", "minecraft_bridge"],
    ] as const
  ) {
    assert.equal(
      parseLauncherP2pAttemptBatch(
        launcherBatch([{
          ...launcherAttempt(),
          kind,
          failedStage,
          outcome: "cancelled",
          failureCode: undefined,
        }]),
        now,
      )?.attempts[0].kind,
      kind,
    );
  }
  assert.equal(
    parseLauncherP2pAttemptBatch(
      launcherBatch(Array.from({ length: 51 }, launcherAttempt)),
      now,
    ),
    undefined,
  );
  for (
    const invalidBatch of [
      { attempts: [launcherAttempt()] },
      { expectedAccountId: "account_telemetry", attempts: [launcherAttempt()] },
      {
        ...launcherBatch([launcherAttempt()]),
        unexpected: true,
      },
    ]
  ) {
    assert.equal(parseLauncherP2pAttemptBatch(invalidBatch, now), undefined);
  }

  for (
    const unsafe of [
      { ...launcherAttempt(), accountId: "acct_forged" },
      { ...launcherAttempt(), eventId: crypto.randomUUID() },
      { ...launcherAttempt(), stage: "ice_connection" },
      { ...launcherAttempt(), roomId: "secret-room-code" },
      { ...launcherAttempt(), candidate: "192.0.2.1:3478" },
      { ...launcherAttempt(), error: "raw provider error" },
      { ...launcherAttempt(), nested: { anything: true } },
      { ...launcherAttempt(), kind: undefined },
      { ...launcherAttempt(), kind: "room_admission" },
      { ...launcherAttempt(), outcome: "started" },
      { ...launcherAttempt(), failedStage: undefined },
      { ...launcherAttempt(), failureCode: undefined },
      { ...launcherAttempt(), failedStage: "room_admission" },
      { ...launcherAttempt(), failureCode: "room_not_found" },
      { ...launcherAttempt(), failureCode: "room_full" },
      { ...launcherAttempt(), failureCode: "room_closed" },
      { ...launcherAttempt(), failureCode: "authentication_failed" },
      { ...launcherAttempt(), failureCode: "ticket_expired" },
      {
        ...launcherAttempt(),
        kind: "signaling_socket",
        failedStage: "ice_connection",
      },
      {
        ...launcherAttempt(),
        kind: "minecraft_bridge",
        failedStage: "metadata_channel",
      },
      {
        ...launcherAttempt(),
        kind: "peer_connection",
        failedStage: "signaling_socket",
      },
      {
        ...launcherAttempt(),
        kind: "signaling_socket",
        failedStage: "signaling_socket",
        failureCode: "bridge_bind_failed",
      },
      {
        ...launcherAttempt(),
        kind: "minecraft_bridge",
        failedStage: "minecraft_bridge",
        failureCode: "ice_connection_failed",
      },
      { ...succeeded, failedStage: "ice_connection" },
      { ...succeeded, failureCode: "ice_connection_failed" },
      { ...launcherAttempt(), route: "direct" },
      { ...launcherAttempt(), localCandidateType: "srflx" },
      { ...launcherAttempt(), deviceId: undefined },
      { ...launcherAttempt(), launcherSessionId: undefined },
      { ...launcherAttempt(), launcherVersion: undefined },
      { ...launcherAttempt(), launcherBuild: undefined },
      { ...launcherAttempt(), durationMs: 24 * 60 * 60 * 1_000 + 1 },
      {
        ...launcherAttempt(),
        outcome: "cancelled",
        failedStage: undefined,
        failureCode: undefined,
      },
      {
        ...launcherAttempt(),
        outcome: "closed",
        failedStage: undefined,
        failureCode: undefined,
      },
    ]
  ) {
    assert.equal(
      parseLauncherP2pAttemptBatch(launcherBatch([unsafe]), now),
      undefined,
    );
  }
});

Deno.test("P2P attempt identity is account plus attemptId across retries", async () => {
  const db = new TelemetryDb();
  const repository = new MongoLauncherP2pAttemptRepository(db);
  const attempt = launcherAttempt();
  const stored = {
    ...attempt,
    accountId: "acct_telemetry",
    receivedAt: new Date("2026-08-27T12:01:00.000Z"),
  };
  assert.equal(await repository.record(stored), "recorded");
  assert.equal(
    await repository.record({ ...stored, retry: stored.retry + 1 }),
    "duplicate",
  );
  assert.equal(
    await repository.record({ ...stored, accountId: "acct_other" }),
    "recorded",
  );
  assert.equal(db.attempts.documents.size, 2);
  assert.equal(
    db.attempts.documents.has(
      `acct_telemetry:${attempt.attemptId}`,
    ),
    true,
  );
  assert.deepEqual(
    db.attempts.indexes.map((index) => index.options?.name).sort(),
    [
      "p2p_attempt_account_received",
      "p2p_attempt_outcome_failure_received",
      "p2p_attempt_received_expiry",
      "p2p_attempt_room_session",
      "p2p_attempt_turn_session",
    ],
  );
  assert.equal(
    db.attempts.indexes.find((index) =>
      index.options?.name === "p2p_attempt_received_expiry"
    )?.options?.expireAfterSeconds,
    90 * 24 * 60 * 60,
  );
  assert.equal(
    db.attempts.indexes.find((index) =>
      index.options?.name === "p2p_attempt_turn_session"
    )?.options?.sparse,
    true,
  );
});

Deno.test("room admission and AI audit telemetry use dedicated collections", async () => {
  const db = new TelemetryDb();
  const admissions = new MongoRoomAdmissionTelemetryRepository(db);
  const now = new Date("2026-08-27T12:01:00.000Z");
  assert.equal(
    await admissions.record({
      schemaVersion: 1,
      admissionId: "admission_1",
      accountId: "acct_telemetry",
      roomSessionId: "44444444-4444-4444-8444-444444444444",
      source: "signaling",
      occurredAt: now.toISOString(),
      receivedAt: now,
      role: "member",
      outcome: "succeeded",
    }),
    "recorded",
  );
  assert.equal(db.admissions.documents.size, 1);
  assert.equal(db.attempts.documents.size, 0);
  assert.deepEqual(
    db.admissions.indexes.map((index) => index.options?.name).sort(),
    [
      "room_admission_account_received",
      "room_admission_received_expiry",
      "room_admission_room_session",
    ],
  );

  const ai = new MongoAiAuditRepository(db);
  const audit = {
    requestId: "ai_opaque_request",
    accountId: "acct_telemetry",
    provider: "agnes_or_deepseek",
    model: "agnes-2.5-flash",
    outcome: "succeeded" as const,
    statusClass: "2xx" as const,
    promptTokens: 12,
    cachedPromptTokens: 3,
    completionTokens: 4,
    billedUnits: 21,
    durationMs: 14,
    receivedAt: now,
  };
  assert.equal(await ai.record(audit), "recorded");
  assert.equal(await ai.record(audit), "duplicate");
  assert.equal(
    db.ai.indexes.find((index) =>
      index.options?.name === "ai_audit_received_expiry"
    )?.options?.expireAfterSeconds,
    90 * 24 * 60 * 60,
  );
});
