import type {
  CfWebSocket,
  DurableObjectState,
  ResponseInitWithWebSocket,
} from "./cf_types.ts";
import {
  type MultiplayerRole,
  verifyMultiplayerTicket,
} from "../src/lib/multiplayerTicket.ts";

type MemberStatus = "negotiating" | "connected";

interface RoomMember {
  peerId: string;
  accountId: string;
  displayName: string;
  status: MemberStatus;
  joinedAt: number;
}

interface RoomState {
  roomId: string;
  masterAccountId: string;
  masterPeerId?: string;
  status: "waiting-master" | "open" | "closed";
  createdAt: number;
  expiresAt: number;
  maxPeers: number;
  revision: number;
  members: Record<string, RoomMember>;
}

interface PeerSession {
  peerId: string;
  accountId: string;
  displayName: string;
  joinedAt: number;
  messageWindowStartedAt: number;
  messageCount: number;
}

interface MultiplayerRoomObjectEnv {
  XMCL_MULTIPLAYER_TICKET_SECRET?: string;
}

const MAX_MESSAGE_BYTES = 64 * 1024;
const MASTER_RECONNECT_GRACE_MS = 30_000;
const OPEN = 1;

export class MultiplayerRoomObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: MultiplayerRoomObjectEnv,
  ) {}

  fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/initialize") return this.initialize(request);
    if (url.pathname === "/admission") return this.admission(request);
    if (url.pathname === "/close") return this.closeRoom(request);
    if (url.pathname !== "/connect") {
      return Promise.resolve(new Response("Not found", { status: 404 }));
    }
    return this.connect(request, url);
  }

  async alarm(): Promise<void> {
    const room = await this.room();
    if (!room || room.status === "closed") return;
    if (room.expiresAt <= Date.now() || room.status === "waiting-master") {
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

    let input: Record<string, unknown>;
    try {
      const parsed = JSON.parse(message);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Expected an object");
      }
      input = parsed as Record<string, unknown>;
    } catch {
      this.send(socket, { type: "error", code: "invalid_message" });
      return;
    }

    const room = await this.room();
    if (!room || room.status === "closed") {
      socket.close(4000, "Room closed");
      return;
    }
    const member = room.members[sender.peerId];
    if (!member || member.accountId !== sender.accountId) {
      this.send(socket, { type: "error", code: "member_not_admitted" });
      return;
    }
    const isMaster = sender.peerId === room.masterPeerId;

    if (input.type === "signal") {
      this.routeSignal(room, sender, socket, input, isMaster);
      return;
    }

    if (input.type === "rtc-ready") {
      if (!this.hasOnlyKeys(input, ["type"])) {
        this.send(socket, { type: "error", code: "invalid_message" });
        return;
      }
      if (isMaster) {
        this.send(socket, { type: "error", code: "rtc_ready_forbidden" });
        return;
      }
      if (member.status === "connected") return;
      member.status = "connected";
      room.revision++;
      await this.persist(room);
      this.broadcastRoomState(room);
      return;
    }

    if (input.type === "transfer-master") {
      if (
        !this.hasOnlyKeys(input, ["type", "peerId"]) ||
        typeof input.peerId !== "string"
      ) {
        this.send(socket, { type: "error", code: "invalid_master_target" });
        return;
      }
      if (!isMaster) {
        this.send(socket, {
          type: "error",
          code: "transfer_master_forbidden",
        });
        return;
      }
      await this.transferMaster(room, input.peerId, socket);
      return;
    }

    if (input.type === "remove-member") {
      if (
        !this.hasOnlyKeys(input, ["type", "peerId"]) ||
        typeof input.peerId !== "string"
      ) {
        this.send(socket, { type: "error", code: "invalid_member_target" });
        return;
      }
      if (!isMaster) {
        this.send(socket, {
          type: "error",
          code: "remove_member_forbidden",
        });
        return;
      }
      await this.removeMember(room, input.peerId, socket);
      return;
    }

    this.send(socket, { type: "error", code: "unsupported_message" });
  }

  async webSocketClose(
    socket: CfWebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    if (code !== 1005 && code !== 1006 && code !== 1015) {
      socket.close(code, reason);
    }
    const peer = socket.deserializeAttachment<PeerSession>();
    const room = await this.room();
    if (!peer || !room || room.status === "closed") return;

    const member = room.members[peer.peerId];
    if (!member || member.accountId !== peer.accountId) return;
    if (peer.peerId === room.masterPeerId) {
      room.status = "waiting-master";
      for (const current of Object.values(room.members)) {
        current.status = "negotiating";
      }
      room.revision++;
      await this.persist(room);
      await this.state.storage.setAlarm(
        Math.min(
          room.expiresAt,
          Date.now() + MASTER_RECONNECT_GRACE_MS,
        ),
      );
      this.broadcastRoomState(room, socket);
      return;
    }

    delete room.members[peer.peerId];
    room.revision++;
    await this.persist(room);
    this.broadcastRoomState(room, socket);
  }

  webSocketError(socket: CfWebSocket): void {
    socket.close(1011, "WebSocket error");
  }

  private async initialize(request: Request): Promise<Response> {
    if (!this.isInternal(request)) {
      return new Response("Forbidden", { status: 403 });
    }
    const input = await this.jsonObject(request);
    if (!input || typeof input.roomId !== "string") {
      return new Response("Invalid room", { status: 400 });
    }
    const existing = await this.room();
    if (existing) {
      const sameRoom = existing.roomId === input.roomId;
      return new Response(sameRoom ? null : "Conflict", {
        status: sameRoom ? 204 : 409,
      });
    }
    if (
      typeof input.masterAccountId !== "string" ||
      !Number.isSafeInteger(input.maxPeers) || Number(input.maxPeers) < 2 ||
      Number(input.maxPeers) > 16 ||
      !Number.isSafeInteger(input.expiresAt) ||
      Number(input.expiresAt) <= Date.now()
    ) {
      return new Response("Invalid room", { status: 400 });
    }
    const room: RoomState = {
      roomId: input.roomId,
      masterAccountId: input.masterAccountId,
      status: "waiting-master",
      createdAt: Date.now(),
      expiresAt: Number(input.expiresAt),
      maxPeers: Number(input.maxPeers),
      revision: 0,
      members: {},
    };
    await this.persist(room);
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
    const input = await this.jsonObject(request);
    if (!input || typeof input.accountId !== "string") {
      return new Response("Invalid admission", { status: 400 });
    }
    if (input.accountId === room.masterAccountId) {
      return Response.json({
        role: "master" satisfies MultiplayerRole,
        maxPeers: room.maxPeers,
      });
    }
    if (room.status !== "open" || !this.masterSocket(room)) {
      return new Response("Master unavailable", { status: 409 });
    }
    const existing = Object.values(room.members).find((member) =>
      member.peerId !== room.masterPeerId &&
      member.accountId === input.accountId
    );
    if (!existing && Object.keys(room.members).length >= room.maxPeers) {
      return new Response("Room full", { status: 409 });
    }
    return Response.json({
      role: "member" satisfies MultiplayerRole,
      maxPeers: room.maxPeers,
    });
  }

  private async closeRoom(request: Request): Promise<Response> {
    if (!this.isInternal(request)) {
      return new Response("Forbidden", { status: 403 });
    }
    const room = await this.room();
    if (!room) return new Response("Not found", { status: 404 });
    const input = await this.jsonObject(request);
    if (!input || input.accountId !== room.masterAccountId) {
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

    const isCurrentMaster = claims.accountId === room.masterAccountId;
    if (claims.role === "master" && !isCurrentMaster) {
      return new Response("Invalid master ticket", { status: 403 });
    }
    if (claims.role === "member" && isCurrentMaster) {
      return new Response("Invalid member ticket", { status: 403 });
    }
    if (claims.role === "member") {
      if (room.status !== "open" || !this.masterSocket(room)) {
        return new Response("Master unavailable", { status: 409 });
      }
      const previous = Object.values(room.members).find((member) =>
        member.peerId !== room.masterPeerId &&
        member.accountId === claims.accountId
      );
      if (!previous && Object.keys(room.members).length >= room.maxPeers) {
        return new Response("Room full", { status: 409 });
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
      joinedAt: Date.now(),
      messageWindowStartedAt: Date.now(),
      messageCount: 0,
    };
    server.serializeAttachment(peer);
    this.state.acceptWebSocket(server);
    await this.joinRoom(room, peer, claims.role, server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInitWithWebSocket);
  }

  private async joinRoom(
    room: RoomState,
    peer: PeerSession,
    role: MultiplayerRole,
    socket: CfWebSocket,
  ): Promise<void> {
    if (role === "master") {
      const previousPeerId = room.masterPeerId;
      const previousMaster = previousPeerId
        ? room.members[previousPeerId]
        : undefined;
      if (previousPeerId && previousPeerId !== peer.peerId) {
        this.liveSocketByPeer(previousPeerId)?.close(
          4001,
          "Master reconnected",
        );
        delete room.members[previousPeerId];
      }
      for (const member of Object.values(room.members)) {
        member.status = "negotiating";
      }
      room.masterAccountId = peer.accountId;
      room.masterPeerId = peer.peerId;
      room.members[peer.peerId] = {
        peerId: peer.peerId,
        accountId: peer.accountId,
        displayName: peer.displayName,
        status: "connected",
        joinedAt: previousMaster?.joinedAt ?? peer.joinedAt,
      };
      room.status = "open";
    } else {
      const previous = Object.values(room.members).find((member) =>
        member.peerId !== room.masterPeerId &&
        member.accountId === peer.accountId
      );
      if (previous && previous.peerId !== peer.peerId) {
        this.liveSocketByPeer(previous.peerId)?.close(
          4001,
          "Member reconnected",
        );
        delete room.members[previous.peerId];
      }
      room.members[peer.peerId] = {
        peerId: peer.peerId,
        accountId: peer.accountId,
        displayName: peer.displayName,
        status: "negotiating",
        joinedAt: previous?.joinedAt ?? peer.joinedAt,
      };
    }
    room.revision++;
    await this.persist(room);
    await this.state.storage.setAlarm(room.expiresAt);
    if (socket.readyState === OPEN) this.broadcastRoomState(room);
  }

  private routeSignal(
    room: RoomState,
    sender: PeerSession,
    socket: CfWebSocket,
    input: Record<string, unknown>,
    isMaster: boolean,
  ): void {
    if (input.payload === undefined) {
      this.send(socket, { type: "error", code: "invalid_message" });
      return;
    }
    if (isMaster) {
      if (
        !this.hasOnlyKeys(input, ["type", "receiver", "payload"]) ||
        typeof input.receiver !== "string" ||
        input.receiver === room.masterPeerId ||
        !room.members[input.receiver] ||
        !this.liveSocketByPeer(input.receiver)
      ) {
        this.send(socket, { type: "error", code: "invalid_receiver" });
        return;
      }
      this.sendToPeer(input.receiver, {
        type: "signal",
        sender: sender.peerId,
        payload: input.payload,
      });
      return;
    }
    if (!this.hasOnlyKeys(input, ["type", "payload"])) {
      this.send(socket, { type: "error", code: "invalid_message" });
      return;
    }
    const master = this.masterSocket(room);
    if (!master) {
      this.send(socket, { type: "error", code: "master_unavailable" });
      return;
    }
    this.send(master, {
      type: "signal",
      sender: sender.peerId,
      payload: input.payload,
    });
  }

  private async transferMaster(
    room: RoomState,
    targetPeerId: string,
    senderSocket: CfWebSocket,
  ): Promise<void> {
    const target = room.members[targetPeerId];
    if (
      !target ||
      targetPeerId === room.masterPeerId ||
      target.status !== "connected" ||
      !this.liveSocketByPeer(targetPeerId)
    ) {
      this.send(senderSocket, {
        type: "error",
        code: "master_target_unavailable",
      });
      return;
    }

    room.masterPeerId = target.peerId;
    room.masterAccountId = target.accountId;
    room.status = "open";
    for (const member of Object.values(room.members)) {
      member.status = member.peerId === target.peerId
        ? "connected"
        : "negotiating";
    }
    room.revision++;
    await this.persist(room);
    this.broadcastRoomState(room);
  }

  private async removeMember(
    room: RoomState,
    peerId: string,
    senderSocket: CfWebSocket,
  ): Promise<void> {
    const member = room.members[peerId];
    if (!member || peerId === room.masterPeerId) {
      this.send(senderSocket, {
        type: "error",
        code: "member_target_unavailable",
      });
      return;
    }
    delete room.members[peerId];
    room.revision++;
    await this.persist(room);
    this.liveSocketByPeer(peerId)?.close(4003, "Removed by master");
    this.broadcastRoomState(room);
  }

  private async finishRoom(room: RoomState, reason: string): Promise<void> {
    room.status = "closed";
    room.revision++;
    await this.persist(room);
    this.broadcastRoomState(room);
    await this.state.storage.deleteAlarm();
    for (const socket of this.state.getWebSockets()) {
      socket.close(4000, reason);
    }
    await this.state.storage.deleteAll();
  }

  private room(): Promise<RoomState | undefined> {
    return this.state.storage.get<RoomState>("room");
  }

  private persist(room: RoomState): Promise<void> {
    return this.state.storage.put("room", room);
  }

  private async jsonObject(
    request: Request,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const value = await request.json();
      return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
    } catch {
      return undefined;
    }
  }

  private isInternal(request: Request): boolean {
    const secret = this.env.XMCL_MULTIPLAYER_TICKET_SECRET;
    return Boolean(secret) &&
      request.headers.get("x-room-internal-secret") === secret;
  }

  private masterSocket(room: RoomState): CfWebSocket | undefined {
    return room.masterPeerId
      ? this.liveSocketByPeer(room.masterPeerId)
      : undefined;
  }

  private socketByPeer(peerId: string): CfWebSocket | undefined {
    return this.state.getWebSockets().find((socket) =>
      socket.deserializeAttachment<PeerSession>()?.peerId === peerId
    );
  }

  private liveSocketByPeer(peerId: string): CfWebSocket | undefined {
    const socket = this.socketByPeer(peerId);
    return socket?.readyState === OPEN ? socket : undefined;
  }

  private sendToPeer(peerId: string, message: unknown): void {
    const socket = this.liveSocketByPeer(peerId);
    if (socket) this.send(socket, message);
  }

  private members(room: RoomState): RoomMember[] {
    return Object.values(room.members).sort((left, right) =>
      left.joinedAt - right.joinedAt ||
      left.peerId.localeCompare(right.peerId)
    );
  }

  private broadcastRoomState(
    room: RoomState,
    excluded?: CfWebSocket,
  ): void {
    const members = this.members(room);
    for (const socket of this.liveSockets()) {
      if (socket === excluded) continue;
      const self = socket.deserializeAttachment<PeerSession>();
      if (!self) continue;
      this.send(socket, {
        type: "room-state",
        selfPeerId: self.peerId,
        masterPeerId: room.masterPeerId,
        members,
        status: room.status,
        maxPeers: room.maxPeers,
        revision: room.revision,
      });
    }
  }

  private liveSockets(): CfWebSocket[] {
    return this.state.getWebSockets().filter((socket) =>
      socket.readyState === OPEN
    );
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

  private hasOnlyKeys(
    input: Record<string, unknown>,
    allowed: string[],
  ): boolean {
    const allowedKeys = new Set(allowed);
    return Object.keys(input).every((key) => allowedKeys.has(key)) &&
      allowed.every((key) => Object.hasOwn(input, key));
  }

  private send(socket: CfWebSocket, message: unknown): void {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // A concurrently closed socket is cleaned up by webSocketClose.
    }
  }
}
