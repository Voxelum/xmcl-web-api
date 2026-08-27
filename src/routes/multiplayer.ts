import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { getConfig } from "../config.ts";
import {
  type MultiplayerRole,
  signMultiplayerTicket,
} from "../multiplayerTicket.ts";
import { normalizeMultiplayerRoomId } from "../multiplayerRoomId.ts";
import { xmclAuth } from "../middleware/xmclAuth.ts";
import type { AccountRuntimeResolver } from "../middleware/xmclAuth.ts";
import { handleAccountError } from "../accountHttp.ts";
import {
  type LauncherP2pAttemptRepository,
  MAX_MULTIPLAYER_TELEMETRY_BODY_BYTES,
  MongoLauncherP2pAttemptRepository,
  MongoRoomAdmissionTelemetryRepository,
  parseLauncherP2pAttemptBatch,
  type RoomAdmissionFailureCode,
  type RoomAdmissionTelemetryRepository,
} from "../telemetry.ts";
import type { AppEnv } from "../types.ts";

interface MultiplayerRoomObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface MultiplayerRoomObjectNamespace {
  idFromName(name: string): unknown;
  get(
    id: unknown,
    options?: { locationHint?: string },
  ): MultiplayerRoomObjectStub;
}

const TICKET_TTL_MS = 5 * 60_000;
const ROOM_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_PEERS = 8;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface MultiplayerRouteOptions {
  resolveAttemptTelemetry?: (
    c: Context<AppEnv>,
  ) => Promise<LauncherP2pAttemptRepository>;
  resolveAdmissionTelemetry?: (
    c: Context<AppEnv>,
  ) => Promise<RoomAdmissionTelemetryRepository>;
}

function namespace(
  c: { env: AppEnv["Bindings"] },
): MultiplayerRoomObjectNamespace {
  const binding = c.env.MULTIPLAYER_ROOMS as
    | MultiplayerRoomObjectNamespace
    | undefined;
  if (!binding) {
    throw new HTTPException(501, {
      message: "Multiplayer rooms are not supported on this platform",
    });
  }
  return binding;
}

function ticketSecret(c: Context<AppEnv>): string {
  const secret = typeof c.env.XMCL_MULTIPLAYER_TICKET_SECRET === "string"
    ? c.env.XMCL_MULTIPLAYER_TICKET_SECRET
    : getConfig(c).XMCL_MULTIPLAYER_TICKET_SECRET;
  if (!secret) {
    throw new HTTPException(503, {
      message: "Multiplayer room ticket signing is not configured",
    });
  }
  if (secret.length < 32) {
    throw new HTTPException(503, {
      message: "Multiplayer room ticket signing secret is too short",
    });
  }
  return secret;
}

function randomId(): string {
  return crypto.randomUUID();
}

function displayName(value: unknown): string {
  if (typeof value !== "string") return "Player";
  const normalized = value.trim();
  if (!normalized || normalized.length > 32) {
    throw new HTTPException(400, {
      message: "displayName must be 1-32 characters",
    });
  }
  return normalized;
}

function maxPeers(value: unknown): number {
  const normalized = value === undefined ? DEFAULT_MAX_PEERS : value;
  if (
    !Number.isSafeInteger(normalized) || Number(normalized) < 2 ||
    Number(normalized) > 16
  ) {
    throw new HTTPException(400, {
      message: "maxPeers must be an integer from 2 to 16",
    });
  }
  return Number(normalized);
}

async function body(
  c: { req: { json(): Promise<unknown> } },
): Promise<Record<string, unknown>> {
  try {
    const value = await c.req.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error();
    }

    return value as Record<string, unknown>;
  } catch {
    throw new HTTPException(400, { message: "Expected a JSON object" });
  }
}

async function telemetryBody(c: Context<AppEnv>): Promise<unknown> {
  const contentLength = c.req.header("content-length");
  if (
    contentLength && (!/^[0-9]+$/.test(contentLength) ||
      Number(contentLength) > MAX_MULTIPLAYER_TELEMETRY_BODY_BYTES)
  ) {
    throw new HTTPException(413, { message: "Telemetry batch is too large" });
  }
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new HTTPException(400, { message: "Expected JSON body" });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_MULTIPLAYER_TELEMETRY_BODY_BYTES) {
        await reader.cancel();
        throw new HTTPException(413, {
          message: "Telemetry batch is too large",
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HTTPException(400, { message: "Expected a JSON object" });
  }
}

async function issueTicket(input: {
  roomId: string;
  accountId: string;
  displayName: string;
  role: MultiplayerRole;
  secret: string;
}) {
  const issuedAt = Date.now();
  const peerId = randomId();
  const ticket = await signMultiplayerTicket({
    version: 2,
    roomId: input.roomId,
    accountId: input.accountId,
    peerId,
    displayName: input.displayName,
    role: input.role,
    issuedAt,
    expiresAt: issuedAt + TICKET_TTL_MS,
  }, input.secret);
  return {
    ticket,
    peerId,
    expiresAt: new Date(issuedAt + TICKET_TTL_MS).toISOString(),
  };
}

async function admitRoom(
  c: Context<AppEnv>,
  input: {
    roomId: string;
    accountId: string;
    maxPeers: number;
    createIfMissing: boolean;
    secret: string;
  },
): Promise<{
  role: MultiplayerRole;
  maxPeers: number;
  created: boolean;
  roomSessionId: string;
}> {
  const ns = namespace(c);
  const response = await ns.get(ns.idFromName(input.roomId)).fetch(
    new Request("https://room.internal/admission", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-room-internal-secret": input.secret,
      },
      body: JSON.stringify({
        roomId: input.roomId,
        accountId: input.accountId,
        maxPeers: input.maxPeers,
        createIfMissing: input.createIfMissing,
        expiresAt: Date.now() + ROOM_TTL_MS,
      }),
    }),
  );
  if (response.status === 404) {
    throw new HTTPException(404, { message: "Room not found" });
  }
  if (response.status === 409) {
    const reason = await response.text();
    throw new HTTPException(409, {
      message: reason || "Room unavailable",
    });
  }
  if (response.status === 410) {
    throw new HTTPException(410, { message: "Room closed" });
  }
  if (!response.ok) {
    throw new HTTPException(502, {
      message: "Unable to check multiplayer room",
    });
  }
  const state = await response.json() as {
    role?: unknown;
    maxPeers?: unknown;
    created?: unknown;
    roomSessionId?: unknown;
  };
  if (
    (state.role !== "master" && state.role !== "member") ||
    !Number.isSafeInteger(state.maxPeers) ||
    Number(state.maxPeers) < 2 ||
    Number(state.maxPeers) > 16 ||
    typeof state.created !== "boolean" ||
    typeof state.roomSessionId !== "string" ||
    !UUID.test(state.roomSessionId)
  ) {
    throw new HTTPException(502, {
      message: "Invalid multiplayer room admission",
    });
  }
  return {
    role: state.role,
    maxPeers: Number(state.maxPeers),
    created: state.created,
    roomSessionId: state.roomSessionId,
  };
}

export function createMultiplayerRoutes(
  resolve?: AccountRuntimeResolver,
  options: MultiplayerRouteOptions = {},
) {
  const app = new Hono<AppEnv>();
  app.onError((error, c) =>
    error instanceof HTTPException
      ? error.getResponse()
      : handleAccountError(error, c)
  );
  const resolveAttemptTelemetry = options.resolveAttemptTelemetry ?? (async (
    c: Context<AppEnv>,
  ) => new MongoLauncherP2pAttemptRepository(await c.get("getDb")()));
  const resolveAdmissionTelemetry = options.resolveAdmissionTelemetry ??
    (async (
      c: Context<AppEnv>,
    ) => new MongoRoomAdmissionTelemetryRepository(await c.get("getDb")()));
  app.use("/v1/multiplayer/*", xmclAuth(["account:read"], resolve));

  const recordAdmission = async (
    c: Context<AppEnv>,
    role: MultiplayerRole,
    outcome: "succeeded" | "failed",
    failureCode?: RoomAdmissionFailureCode,
    roomSessionId?: string,
  ) => {
    const now = new Date();
    const admission = {
      schemaVersion: 1 as const,
      admissionId: crypto.randomUUID(),
      accountId: c.get("xmclPrincipal")!.accountId,
      occurredAt: now.toISOString(),
      receivedAt: now,
      source: "signaling" as const,
      role,
      outcome,
      ...(failureCode ? { failureCode } : {}),
      ...(roomSessionId ? { roomSessionId } : {}),
    };
    const work = Promise.resolve()
      .then(() => resolveAdmissionTelemetry(c))
      .then((telemetry) => telemetry.record(admission))
      .catch((error) => {
        console.error({
          event: "multiplayer.room_admission_telemetry_failed",
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      });
    const waitUntil = c.get("waitUntil");
    if (waitUntil) waitUntil(work);
    else await work;
  };

  app.post("/v1/multiplayer/telemetry/attempts", async (c) => {
    const batch = parseLauncherP2pAttemptBatch(await telemetryBody(c));
    if (!batch) {
      throw new HTTPException(400, {
        message: "Invalid privacy-safe telemetry batch",
      });
    }
    const receivedAt = new Date();
    const accountId = c.get("xmclPrincipal")!.accountId;
    if (batch.expectedAccountId !== accountId) {
      throw new HTTPException(409, {
        message: "Telemetry batch account does not match authenticated account",
      });
    }
    const limiter = c.env.MULTIPLAYER_TELEMETRY_RATE_LIMITER;
    if (!limiter) {
      throw new HTTPException(503, {
        message: "Multiplayer telemetry rate limiter unavailable",
      });
    }
    for (let index = 0; index < batch.attempts.length; index++) {
      const { success } = await limiter.limit({
        key: `multiplayer-telemetry:${accountId}`,
      });
      if (!success) {
        return c.json(
          { message: "Multiplayer telemetry rate limit exceeded" },
          429,
          { "Retry-After": "60" },
        );
      }
    }
    const telemetry = await resolveAttemptTelemetry(c);
    let accepted = 0;
    let duplicate = 0;
    for (const attempt of batch.attempts) {
      const result = await telemetry.record({
        ...attempt,
        accountId,
        receivedAt,
      });
      if (result === "duplicate") duplicate += 1;
      else accepted += 1;
    }
    return c.json({ accepted, duplicate }, 202);
  });

  app.post("/v1/multiplayer/rooms", async (c) => {
    const input = await body(c);
    const roomMaxPeers = maxPeers(input.maxPeers);
    const masterDisplayName = displayName(input.displayName);
    const secret = ticketSecret(c);
    const roomId = randomId();
    const principal = c.get("xmclPrincipal")!;
    let admissionState: Awaited<ReturnType<typeof admitRoom>>;
    try {
      admissionState = await admitRoom(c, {
        roomId,
        accountId: principal.accountId,
        maxPeers: roomMaxPeers,
        createIfMissing: true,
        secret,
      });
    } catch (error) {
      await recordAdmission(
        c,
        "master",
        "failed",
        error instanceof HTTPException && error.status === 404
          ? "room_not_found"
          : error instanceof HTTPException && error.status === 410
          ? "room_closed"
          : "unknown",
      );
      throw error;
    }
    if (admissionState.role !== "master" || !admissionState.created) {
      await recordAdmission(c, "master", "failed", "unknown");
      throw new HTTPException(502, {
        message: "Unable to initialize multiplayer room",
      });
    }
    await recordAdmission(
      c,
      admissionState.role,
      "succeeded",
      undefined,
      admissionState.roomSessionId,
    );
    const admission = await issueTicket({
      roomId,
      accountId: principal.accountId,
      displayName: masterDisplayName,
      role: admissionState.role,
      secret,
    });
    return c.json({
      roomId,
      roomSessionId: admissionState.roomSessionId,
      maxPeers: admissionState.maxPeers,
      role: admissionState.role,
      socketUrl: `/v1/multiplayer/rooms/${roomId}/socket`,
      ...admission,
    }, 201);
  });

  app.post("/v1/multiplayer/rooms/:roomId/join", async (c) => {
    const input = await body(c);
    const roomId = normalizeMultiplayerRoomId(c.req.param("roomId"));
    if (!roomId) {
      throw new HTTPException(400, {
        message:
          "Room id must use 1-64 letters, numbers, underscores, or hyphens",
      });
    }
    const principal = c.get("xmclPrincipal")!;
    const secret = ticketSecret(c);
    const memberDisplayName = displayName(input.displayName);
    if (typeof input.createIfMissing !== "boolean") {
      throw new HTTPException(400, {
        message: "createIfMissing must be a boolean",
      });
    }
    let admissionState: Awaited<ReturnType<typeof admitRoom>>;
    try {
      admissionState = await admitRoom(c, {
        roomId,
        accountId: principal.accountId,
        maxPeers: maxPeers(input.maxPeers),
        createIfMissing: input.createIfMissing,
        secret,
      });
    } catch (error) {
      const message = error instanceof HTTPException ? error.message : "";
      await recordAdmission(
        c,
        "member",
        "failed",
        error instanceof HTTPException && error.status === 404
          ? "room_not_found"
          : error instanceof HTTPException && error.status === 410
          ? "room_closed"
          : error instanceof HTTPException && error.status === 409 &&
              message === "Room full"
          ? "room_full"
          : "unknown",
      );
      throw error;
    }
    await recordAdmission(
      c,
      admissionState.role,
      "succeeded",
      undefined,
      admissionState.roomSessionId,
    );
    const admission = await issueTicket({
      roomId,
      accountId: principal.accountId,
      displayName: memberDisplayName,
      role: admissionState.role,
      secret,
    });
    return c.json({
      roomId,
      roomSessionId: admissionState.roomSessionId,
      role: admissionState.role,
      maxPeers: admissionState.maxPeers,
      socketUrl: `/v1/multiplayer/rooms/${roomId}/socket`,
      ...admission,
    }, admissionState.created ? 201 : 200);
  });

  app.delete("/v1/multiplayer/rooms/:roomId", async (c) => {
    const roomId = normalizeMultiplayerRoomId(c.req.param("roomId"));
    if (!roomId) {
      throw new HTTPException(400, { message: "Invalid room id" });
    }
    const principal = c.get("xmclPrincipal")!;
    const secret = ticketSecret(c);
    const ns = namespace(c);
    const response = await ns.get(ns.idFromName(roomId)).fetch(
      new Request("https://room.internal/close", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-room-internal-secret": secret,
        },
        body: JSON.stringify({ accountId: principal.accountId }),
      }),
    );
    if (response.status === 403) {
      throw new HTTPException(403, {
        message: "Only the current room master can close the room",
      });
    }
    if (response.status === 404) {
      throw new HTTPException(404, { message: "Room not found" });
    }
    if (!response.ok) {
      throw new HTTPException(502, { message: "Unable to close room" });
    }
    return c.body(null, 204);
  });

  return app;
}

export default createMultiplayerRoutes();
