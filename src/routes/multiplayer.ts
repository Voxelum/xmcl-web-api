import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { getConfig } from "../config.ts";
import {
  type MultiplayerRole,
  signMultiplayerTicket,
} from "../lib/multiplayerTicket.ts";
import { xmclAuth } from "../middleware/xmclAuth.ts";
import type { AccountRuntimeResolver } from "../middleware/xmclAuth.ts";
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

function namespace(
  c: { env: AppEnv["Bindings"] },
): MultiplayerRoomObjectNamespace {
  const binding = c.env.MULTIPLAYER_ROOM as
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

export function createMultiplayerRoutes(resolve?: AccountRuntimeResolver) {
  const app = new Hono<AppEnv>();
  app.use("/v1/multiplayer/*", xmclAuth(["account:read"], resolve));

  app.post("/v1/multiplayer/rooms", async (c) => {
    const input = await body(c);
    const maxPeers = input.maxPeers === undefined ? 8 : input.maxPeers;
    if (
      !Number.isSafeInteger(maxPeers) || Number(maxPeers) < 2 ||
      Number(maxPeers) > 16
    ) {
      throw new HTTPException(400, {
        message: "maxPeers must be an integer from 2 to 16",
      });
    }
    const masterDisplayName = displayName(input.displayName);
    const secret = ticketSecret(c);
    const roomId = randomId();
    const principal = c.get("xmclPrincipal")!;
    const ns = namespace(c);
    const stub = ns.get(ns.idFromName(roomId));
    const initialized = await stub.fetch(
      new Request("https://room.internal/initialize", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-room-internal-secret": secret,
        },
        body: JSON.stringify({
          roomId,
          masterAccountId: principal.accountId,
          maxPeers,
          expiresAt: Date.now() + 24 * 60 * 60_000,
        }),
      }),
    );
    if (!initialized.ok) {
      throw new HTTPException(502, {
        message: "Unable to initialize multiplayer room",
      });
    }
    const admission = await issueTicket({
      roomId,
      accountId: principal.accountId,
      displayName: masterDisplayName,
      role: "master",
      secret,
    });
    return c.json({
      roomId,
      maxPeers,
      role: "master" satisfies MultiplayerRole,
      socketUrl: `/v1/multiplayer/rooms/${roomId}/socket`,
      ...admission,
    }, 201);
  });

  app.post("/v1/multiplayer/rooms/:roomId/join", async (c) => {
    const input = await body(c);
    const roomId = c.req.param("roomId");
    if (!/^[0-9a-f-]{36}$/i.test(roomId)) {
      throw new HTTPException(404, { message: "Room not found" });
    }
    const principal = c.get("xmclPrincipal")!;
    const secret = ticketSecret(c);
    const ns = namespace(c);
    const admissionCheck = await ns.get(ns.idFromName(roomId)).fetch(
      new Request("https://room.internal/admission", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-room-internal-secret": secret,
        },
        body: JSON.stringify({ accountId: principal.accountId }),
      }),
    );
    if (admissionCheck.status === 404) {
      throw new HTTPException(404, { message: "Room not found" });
    }
    if (admissionCheck.status === 410) {
      throw new HTTPException(410, { message: "Room closed" });
    }
    if (admissionCheck.status === 409) {
      throw new HTTPException(409, {
        message: (await admissionCheck.text()) || "Room unavailable",
      });
    }
    if (!admissionCheck.ok) {
      throw new HTTPException(502, {
        message: "Unable to check multiplayer room",
      });
    }
    const admissionState = await admissionCheck.json() as {
      role: MultiplayerRole;
      maxPeers: number;
    };
    if (
      !["master", "member"].includes(admissionState.role) ||
      !Number.isSafeInteger(admissionState.maxPeers) ||
      admissionState.maxPeers < 2 ||
      admissionState.maxPeers > 16
    ) {
      throw new HTTPException(502, {
        message: "Invalid multiplayer room admission",
      });
    }
    const admission = await issueTicket({
      roomId,
      accountId: principal.accountId,
      displayName: displayName(input.displayName),
      role: admissionState.role,
      secret,
    });
    return c.json({
      roomId,
      role: admissionState.role,
      maxPeers: admissionState.maxPeers,
      socketUrl: `/v1/multiplayer/rooms/${roomId}/socket`,
      ...admission,
    });
  });

  app.delete("/v1/multiplayer/rooms/:roomId", async (c) => {
    const roomId = c.req.param("roomId");
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
