import type {
  CfWebSocket,
  DurableObjectState,
  ResponseInitWithWebSocket,
} from "./cf_types.ts";
import {
  type MultiplayerRole,
  verifyMultiplayerTicket,
} from "../src/lib/multiplayerTicket.ts";

interface GuestState {
  peerId: string;
  accountId: string;
  displayName: string;
  status: "negotiating" | "connected";
  joinedAt: number;
}

interface RoomState {
  roomId: string;
  ownerId: string;
  hostPeerId?: string;
  status: "waiting-host" | "open" | "closed";
  createdAt: number;
  expiresAt: number;
  maxPeers: number;
  revision: number;
  guests: Record<string, GuestState>;
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
const HOST_RECONNECT_GRACE_MS = 30_000;

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
    if (room.expiresAt <= Date.now() || room.status === "waiting-host") {
      await this.finishRoom(room, "Room expired");
      return;
    }
    await this.state.storage.setAlarm(room.expiresAt);
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
    if (!this.consumeMessage(sender, socket)) return;

    let input: {
      type?: string;
      receiver?: string;
      peerId?: string;
      payload?: unknown;
    };
    try {
      input = JSON.parse(message);
    } catch {
      this.send(socket, { type: "error", code: "invalid_message" });
      return;
    }

    const room = await this.room();
    if (!room || room.status === "closed") {
      socket.close(4000, "Room closed");
      return;
    }
    if (input.type === "signal" && input.payload !== undefined) {
      if (sender.role === "host") {
        if (
          typeof input.receiver !== "string" ||
          !room.guests[input.receiver]
        ) {
          this.send(socket, { type: "error", code: "invalid_receiver" });
          return;
        }
        this.sendToPeer(input.receiver, {
          type: "signal",
          sender: sender.peerId,
          payload: input.payload,
        });
      } else {
        const host = this.hostSocket(room);
        if (!host) {
          this.send(socket, { type: "error", code: "host_unavailable" });
          return;
        }
        this.send(host, {
          type: "signal",
          sender: sender.peerId,
          payload: input.payload,
        });
      }
      return;
    }
    if (input.type === "rtc-ready" && sender.role === "guest") {
      const guest = room.guests[sender.peerId];
      if (!guest) {
        this.send(socket, { type: "error", code: "guest_not_admitted" });
        return;
      }
      guest.status = "connected";
      room.revision++;
      await this.state.storage.put("room", room);
      const host = this.hostSocket(room);
      if (host) {
        this.send(host, {
          type: "guest-connected",
          guest,
          revision: room.revision,
        });
      }
      this.send(socket, { type: "rtc-ready", revision: room.revision });
      socket.close(1000, "Signaling complete");
      return;
    }
    if (
      (input.type === "guest-left" || input.type === "kick") &&
      sender.role === "host" && typeof input.peerId === "string"
    ) {
      await this.removeGuest(room, input.peerId, input.type);
      return;
    }
    if (input.type === "leave") {
      socket.close(1000, "Client left");
      return;
    }
    this.send(socket, { type: "error", code: "unsupported_message" });
  }

  async webSocketClose(
    socket: CfWebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const peer = socket.deserializeAttachment<PeerSession>();
    const room = await this.room();
    if (!peer || !room || room.status === "closed") return;

    if (peer.role === "host") {
      if (room.hostPeerId !== peer.peerId) return;
      room.status = "waiting-host";
      room.revision++;
      await this.state.storage.put("room", room);
      await this.state.storage.setAlarm(
        Math.min(room.expiresAt, Date.now() + HOST_RECONNECT_GRACE_MS),
      );
      for (const guestSocket of this.guestSockets()) {
        guestSocket.close(4002, "Host disconnected");
      }
      return;
    }

    const guest = room.guests[peer.peerId];
    if (!guest || guest.status === "connected") return;
    delete room.guests[peer.peerId];
    room.revision++;
    await this.state.storage.put("room", room);
    const host = this.hostSocket(room);
    if (host) {
      this.send(host, {
        type: "guest-negotiation-ended",
        peerId: peer.peerId,
        revision: room.revision,
      });
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
        { status: existing.ownerId === input.ownerId ? 204 : 409 },
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
    const room: RoomState = {
      roomId: input.roomId,
      ownerId: input.ownerId,
      status: "waiting-host",
      createdAt: Date.now(),
      expiresAt: input.expiresAt!,
      maxPeers: input.maxPeers!,
      revision: 0,
      guests: {},
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
    if (room.status === "closed" || room.expiresAt <= Date.now()) {
      return new Response("Room closed", { status: 410 });
    }
    const { accountId } = await request.json() as { accountId?: string };
    if (accountId === room.ownerId) {
      return Response.json({ role: "host" satisfies MultiplayerRole });
    }
    if (room.status !== "open" || !this.hostSocket(room)) {
      return new Response("Host unavailable", { status: 409 });
    }
    const existing = Object.values(room.guests).find((guest) =>
      guest.accountId === accountId
    );
    if (!existing && Object.keys(room.guests).length >= room.maxPeers - 1) {
      return new Response("Room full", { status: 409 });
    }
    return Response.json({ role: "guest" satisfies MultiplayerRole });
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
    await this.finishRoom(room, "Room closed");
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
    if (room.status === "closed" || room.expiresAt <= Date.now()) {
      return new Response("Room closed", { status: 410 });
    }
    if (await this.state.storage.get<number>(`used:${claims.peerId}`)) {
      return new Response("Admission ticket already used", { status: 401 });
    }
    if (claims.role === "host" && claims.accountId !== room.ownerId) {
      return new Response("Invalid host ticket", { status: 403 });
    }
    if (claims.role === "guest") {
      if (room.status !== "open" || !this.hostSocket(room)) {
        return new Response("Host unavailable", { status: 409 });
      }
      const previous = Object.values(room.guests).find((guest) =>
        guest.accountId === claims.accountId
      );
      if (!previous && Object.keys(room.guests).length >= room.maxPeers - 1) {
        return new Response("Room full", { status: 409 });
      }
      if (previous?.status === "connected") {
        return new Response("Guest already connected", { status: 409 });
      }
      if (previous) {
        this.socketByPeer(previous.peerId)?.close(
          4001,
          "Negotiation restarted",
        );
        delete room.guests[previous.peerId];
      }
    }

    await this.state.storage.put(`used:${claims.peerId}`, claims.expiresAt);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const peer: PeerSession = {
      peerId: claims.peerId,
      accountId: claims.accountId,
      displayName: claims.displayName,
      role: claims.role,
      joinedAt: Date.now(),
      messageWindowStartedAt: Date.now(),
      messageCount: 0,
    };
    server.serializeAttachment(peer);

    if (claims.role === "host") {
      const previousHost = this.hostSocket(room);
      if (previousHost) previousHost.close(4001, "Host reconnected");
      room.hostPeerId = peer.peerId;
      room.status = "open";
      room.revision++;
    } else {
      room.guests[peer.peerId] = {
        peerId: peer.peerId,
        accountId: peer.accountId,
        displayName: peer.displayName,
        status: "negotiating",
        joinedAt: peer.joinedAt,
      };
      room.revision++;
    }

    this.state.acceptWebSocket(server);
    await this.state.storage.put("room", room);
    await this.state.storage.setAlarm(room.expiresAt);

    if (peer.role === "host") {
      this.send(server, {
        type: "host-ready",
        self: peer,
        guests: Object.values(room.guests),
        revision: room.revision,
      });
    } else {
      this.send(server, {
        type: "negotiation-started",
        self: peer,
        hostPeerId: room.hostPeerId,
        revision: room.revision,
      });
      const host = this.hostSocket(room);
      if (host) {
        this.send(host, {
          type: "join-request",
          guest: room.guests[peer.peerId],
          revision: room.revision,
        });
      }
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInitWithWebSocket);
  }

  private consumeMessage(peer: PeerSession, socket: CfWebSocket): boolean {
    const now = Date.now();
    if (now - peer.messageWindowStartedAt >= 10_000) {
      peer.messageWindowStartedAt = now;
      peer.messageCount = 0;
    }
    peer.messageCount++;
    socket.serializeAttachment(peer);
    if (peer.messageCount <= 60) return true;
    socket.close(1008, "Message rate exceeded");
    return false;
  }

  private async removeGuest(
    room: RoomState,
    peerId: string,
    reason: "guest-left" | "kick",
  ): Promise<void> {
    if (!room.guests[peerId]) return;
    delete room.guests[peerId];
    room.revision++;
    await this.state.storage.put("room", room);
    this.socketByPeer(peerId)?.close(
      reason === "kick" ? 4003 : 1000,
      reason === "kick" ? "Removed by host" : "Guest left",
    );
  }

  private async finishRoom(room: RoomState, reason: string): Promise<void> {
    room.status = "closed";
    room.revision++;
    await this.state.storage.put("room", room);
    await this.state.storage.deleteAlarm();
    for (const socket of this.state.getWebSockets()) {
      socket.close(4000, reason);
    }
    await this.state.storage.deleteAll();
  }

  private room(): Promise<RoomState | undefined> {
    return this.state.storage.get<RoomState>("room");
  }

  private isInternal(request: Request): boolean {
    const secret = this.env.XMCL_MULTIPLAYER_TICKET_SECRET;
    return Boolean(secret) &&
      request.headers.get("x-room-internal-secret") === secret;
  }

  private hostSocket(room: RoomState): CfWebSocket | undefined {
    return room.hostPeerId ? this.socketByPeer(room.hostPeerId) : undefined;
  }

  private guestSockets(): CfWebSocket[] {
    return this.state.getWebSockets().filter((socket) =>
      socket.deserializeAttachment<PeerSession>()?.role === "guest"
    );
  }

  private socketByPeer(peerId: string): CfWebSocket | undefined {
    return this.state.getWebSockets().find((socket) =>
      socket.deserializeAttachment<PeerSession>()?.peerId === peerId
    );
  }

  private sendToPeer(peerId: string, message: unknown): void {
    const socket = this.socketByPeer(peerId);
    if (socket) this.send(socket, message);
  }

  private send(socket: CfWebSocket, message: unknown): void {
    socket.send(JSON.stringify(message));
  }
}
