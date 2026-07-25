import type {
  CfWebSocket,
  DurableObjectState,
  ResponseInitWithWebSocket,
} from "./cf_types.ts";
import {
  type MultiplayerRole,
  verifyMultiplayerTicket,
} from "../src/lib/multiplayerTicket.ts";

interface RoomState {
  roomId: string;
  ownerId: string;
  status: "open" | "closed";
  createdAt: number;
  expiresAt: number;
  maxPeers: number;
  revision: number;
}

interface PeerSession {
  peerId: string;
  accountId: string;
  displayName: string;
  role: MultiplayerRole;
  joinedAt: number;
  messageWindowStartedAt: number;
  messageCount: number;
}

interface MultiplayerRoomEnv {
  XMCL_MULTIPLAYER_TICKET_SECRET?: string;
}

const MAX_MESSAGE_BYTES = 64 * 1024;
const EMPTY_ROOM_GRACE_MS = 10 * 60_000;

export class MultiplayerRoom {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: MultiplayerRoomEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/v2/initialize") return this.initialize(request);
    if (url.pathname === "/v2/admission") return this.admission(request);
    if (url.pathname === "/v2/close") return this.closeRoom(request);
    if (url.pathname !== "/v2/connect") {
      return new Response("Not found", { status: 404 });
    }
    return this.connect(request, url);
  }

  async alarm(): Promise<void> {
    const room = await this.room();
    if (!room || room.status === "closed") return;
    const sockets = this.state.getWebSockets();
    if (room.expiresAt <= Date.now() || sockets.length === 0) {
      room.status = "closed";
      room.revision++;
      await this.state.storage.put("room", room);
      for (const socket of sockets) socket.close(4000, "Room expired");
    } else {
      await this.state.storage.setAlarm(room.expiresAt);
    }
  }

  async webSocketMessage(
    socket: CfWebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message !== "string") {
      socket.close(1003, "Binary messages are not supported");
      return;
    }
    if (new TextEncoder().encode(message).byteLength > MAX_MESSAGE_BYTES) {
      socket.close(1009, "Message too large");
      return;
    }
    const sender = socket.deserializeAttachment<PeerSession>();
    if (!sender) {
      socket.close(1011, "Missing peer session");
      return;
    }
    const now = Date.now();
    if (now - sender.messageWindowStartedAt >= 10_000) {
      sender.messageWindowStartedAt = now;
      sender.messageCount = 0;
    }
    sender.messageCount++;
    socket.serializeAttachment(sender);
    if (sender.messageCount > 60) {
      socket.close(1008, "Message rate exceeded");
      return;
    }
    let input: {
      type?: string;
      receiver?: string;
      peerId?: string;
      payload?: unknown;
    };
    try {
      input = JSON.parse(message);
    } catch {
      socket.send(JSON.stringify({ type: "error", code: "invalid_message" }));
      return;
    }
    if (
      input.type === "signal" && typeof input.receiver === "string" &&
      input.payload !== undefined
    ) {
      this.sendTo(input.receiver, {
        type: "signal",
        sender: sender.peerId,
        payload: input.payload,
      });
      return;
    }
    if (
      input.type === "kick" && sender.role === "owner" &&
      typeof input.peerId === "string"
    ) {
      const target = this.socketByPeer(input.peerId);
      if (target && target !== socket) {
        target.close(4003, "Removed by room owner");
      }
      return;
    }
    if (input.type === "leave") {
      socket.close(1000, "Client left");
      return;
    }
    socket.send(JSON.stringify({ type: "error", code: "unsupported_message" }));
  }

  async webSocketClose(
    socket: CfWebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const peer = socket.deserializeAttachment<PeerSession>();
    if (!peer) return;
    const room = await this.room();
    if (!room) return;
    room.revision++;
    await this.state.storage.put("room", room);
    this.broadcast({
      type: "peer-left",
      peerId: peer.peerId,
      revision: room.revision,
    }, socket);
    if (this.state.getWebSockets().length <= 1) {
      await this.state.storage.setAlarm(
        Math.min(room.expiresAt, Date.now() + EMPTY_ROOM_GRACE_MS),
      );
    }
  }

  webSocketError(socket: CfWebSocket): void {
    socket.close(1011, "WebSocket error");
  }

  private async initialize(request: Request): Promise<Response> {
    if (!this.isInternal(request)) {
      return new Response("Forbidden", { status: 403 });
    }
    const input = await request.json() as {
      roomId?: string;
      ownerId?: string;
      maxPeers?: number;
      expiresAt?: number;
    };
    const existing = await this.room();
    if (existing) {
      return new Response(
        existing.ownerId === input.ownerId ? null : "Conflict",
        {
          status: existing.ownerId === input.ownerId ? 204 : 409,
        },
      );
    }
    if (
      !input.roomId || !input.ownerId ||
      !Number.isSafeInteger(input.maxPeers) || input.maxPeers! < 2 ||
      input.maxPeers! > 16 ||
      !Number.isSafeInteger(input.expiresAt) || input.expiresAt! <= Date.now()
    ) {
      return new Response("Invalid room", { status: 400 });
    }
    const expiresAt = input.expiresAt;
    const maxPeers = input.maxPeers;
    if (expiresAt === undefined || maxPeers === undefined) {
      return new Response("Invalid room", { status: 400 });
    }
    const room: RoomState = {
      roomId: input.roomId,
      ownerId: input.ownerId,
      status: "open",
      createdAt: Date.now(),
      expiresAt,
      maxPeers,
      revision: 0,
    };
    await this.state.storage.put("room", room);
    await this.state.storage.setAlarm(room.expiresAt);
    return new Response(null, { status: 204 });
  }

  private async admission(request: Request): Promise<Response> {
    if (!this.isInternal(request)) {
      return new Response("Forbidden", { status: 403 });
    }
    const room = await this.room();
    if (!room) return new Response("Not found", { status: 404 });
    if (room.status !== "open" || room.expiresAt <= Date.now()) {
      return new Response("Room closed", { status: 410 });
    }
    const { accountId } = await request.json() as { accountId?: string };
    const reconnecting = this.state.getWebSockets().some((socket) =>
      socket.deserializeAttachment<PeerSession>()?.accountId === accountId
    );
    if (!reconnecting && this.state.getWebSockets().length >= room.maxPeers) {
      return new Response("Room full", { status: 409 });
    }
    return Response.json({ maxPeers: room.maxPeers });
  }

  private async closeRoom(request: Request): Promise<Response> {
    if (!this.isInternal(request)) {
      return new Response("Forbidden", { status: 403 });
    }
    const room = await this.room();
    if (!room) return new Response("Not found", { status: 404 });
    const { accountId } = await request.json() as { accountId?: string };
    if (accountId !== room.ownerId) {
      return new Response("Forbidden", { status: 403 });
    }
    room.status = "closed";
    room.revision++;
    await this.state.storage.put("room", room);
    await this.state.storage.deleteAlarm();
    for (const socket of this.state.getWebSockets()) {
      socket.close(4000, "Room closed");
    }
    return new Response(null, { status: 204 });
  }

  private async connect(request: Request, url: URL): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }
    const secret = this.env.XMCL_MULTIPLAYER_TICKET_SECRET;
    if (!secret) {
      return new Response("Room authentication unavailable", { status: 503 });
    }
    const ticket = url.searchParams.get("ticket");
    const claims = ticket
      ? await verifyMultiplayerTicket(ticket, secret)
      : undefined;
    const room = await this.room();
    if (!claims || !room || claims.roomId !== room.roomId) {
      return new Response("Invalid admission ticket", { status: 401 });
    }
    if (room.status !== "open" || room.expiresAt <= Date.now()) {
      return new Response("Room closed", { status: 410 });
    }
    if (claims.role === "owner" && claims.accountId !== room.ownerId) {
      return new Response("Invalid owner ticket", { status: 403 });
    }
    if (await this.state.storage.get<number>(`used:${claims.peerId}`)) {
      return new Response("Admission ticket already used", { status: 401 });
    }
    const existing = this.state.getWebSockets();
    const previous = existing.find((socket) =>
      socket.deserializeAttachment<PeerSession>()?.accountId ===
        claims.accountId
    );
    if (!previous && existing.length >= room.maxPeers) {
      return new Response("Room full", { status: 409 });
    }
    if (previous) previous.close(4001, "Reconnected");
    await this.state.storage.put(`used:${claims.peerId}`, claims.expiresAt);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const peer: PeerSession = {
      peerId: claims.peerId,
      accountId: claims.accountId,
      displayName: claims.displayName,
      role: claims.accountId === room.ownerId ? "owner" : "member",
      joinedAt: Date.now(),
      messageWindowStartedAt: Date.now(),
      messageCount: 0,
    };
    server.serializeAttachment(peer);
    this.state.acceptWebSocket(server);
    await this.state.storage.setAlarm(room.expiresAt);
    room.revision++;
    await this.state.storage.put("room", room);
    const peers = this.state.getWebSockets()
      .map((socket) => socket.deserializeAttachment<PeerSession>())
      .filter((value): value is PeerSession => Boolean(value));
    server.send(JSON.stringify({
      type: "snapshot",
      self: peer,
      peers: peers.filter((value) => value.peerId !== peer.peerId),
      revision: room.revision,
    }));
    this.broadcast(
      { type: "peer-joined", peer, revision: room.revision },
      server,
    );
    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInitWithWebSocket);
  }

  private room(): Promise<RoomState | undefined> {
    return this.state.storage.get<RoomState>("room");
  }

  private isInternal(request: Request): boolean {
    const secret = this.env.XMCL_MULTIPLAYER_TICKET_SECRET;
    return Boolean(secret) &&
      request.headers.get("x-room-internal-secret") === secret;
  }

  private socketByPeer(peerId: string): CfWebSocket | undefined {
    return this.state.getWebSockets().find((socket) =>
      socket.deserializeAttachment<PeerSession>()?.peerId === peerId
    );
  }

  private sendTo(peerId: string, message: unknown): void {
    this.socketByPeer(peerId)?.send(JSON.stringify(message));
  }

  private broadcast(message: unknown, exclude?: CfWebSocket): void {
    const serialized = JSON.stringify(message);
    for (const socket of this.state.getWebSockets()) {
      if (socket !== exclude) socket.send(serialized);
    }
  }
}
