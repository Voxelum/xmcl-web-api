import assert from "node:assert/strict";
import type {
  CfWebSocket,
  DurableObjectState,
} from "../../packages/shared/platform/cloudflare/types.ts";
import { MultiplayerRoomObject } from "./room.ts";

const secret = "multiplayer-test-secret-with-at-least-32-characters";

function fixture() {
  const values = new Map<string, unknown>();
  let alarm: number | undefined;
  let roomPuts = 0;
  const sockets: CfWebSocket[] = [];
  const state = {
    id: { toString: () => "room" },
    storage: {
      get: <T>(key: string) =>
        Promise.resolve(values.get(key) as T | undefined),
      put: <T>(key: string, value: T) => {
        values.set(key, value);
        if (key === "room") roomPuts++;
        return Promise.resolve();
      },
      setAlarm: (value: number) => {
        alarm = value;
        return Promise.resolve();
      },
      deleteAlarm: () => {
        alarm = undefined;
        return Promise.resolve();
      },
      deleteAll: () => {
        values.clear();
        return Promise.resolve();
      },
    },
    acceptWebSocket: (socket: CfWebSocket) => sockets.push(socket),
    getWebSockets: () => sockets,
  } satisfies DurableObjectState;
  return {
    object: new MultiplayerRoomObject(state, {
      XMCL_MULTIPLAYER_TICKET_SECRET: secret,
    }),
    values,
    sockets,
    resetRoomPuts: () => {
      roomPuts = 0;
    },
    get roomPuts() {
      return roomPuts;
    },
    get alarm() {
      return alarm;
    },
  };
}

function socketWith(peer: {
  peerId: string;
  accountId: string;
  displayName: string;
}) {
  let attachment: unknown = {
    ...peer,
    joinedAt: Date.now(),
    messageWindowStartedAt: Date.now(),
    messageCount: 0,
  };
  const sent: string[] = [];
  const events: string[] = [];
  let readyState = 1;
  let closed: { code?: number; reason?: string } | undefined;
  const socket: CfWebSocket = {
    get readyState() {
      return readyState;
    },
    accept: () => {},
    addEventListener: () => {},
    send: (message) => {
      sent.push(String(message));
      events.push("send");
    },
    close: (code, reason) => {
      events.push("close");
      readyState = 3;
      closed = { code, reason };
    },
    serializeAttachment: (value) => {
      attachment = value;
    },
    deserializeAttachment: <T>() => attachment as T,
  };
  return {
    socket,
    sent,
    events,
    messages: () => sent.map((message) => JSON.parse(message)),
    clear: () => sent.splice(0),
    get closed() {
      return closed;
    },
  };
}

function internal(path: string, body: unknown) {
  return new Request(`https://room.internal${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-room-internal-secret": secret,
    },
    body: JSON.stringify(body),
  });
}

interface TestRoomState {
  roomId: string;
  masterAccountId: string;
  masterPeerId?: string;
  status: "waiting-master" | "open" | "closed";
  createdAt: number;
  expiresAt: number;
  maxPeers: number;
  revision: number;
  members: Record<string, {
    peerId: string;
    accountId: string;
    displayName: string;
    status: "negotiating" | "connected";
    joinedAt: number;
  }>;
}

function roomState(input?: {
  memberStatus?: "negotiating" | "connected";
}): TestRoomState {
  const joinedAt = Date.now();
  return {
    roomId: "room_1",
    masterAccountId: "account_1",
    masterPeerId: "master_peer",
    status: "open",
    createdAt: joinedAt,
    expiresAt: joinedAt + 60_000,
    maxPeers: 8,
    revision: 1,
    members: {
      master_peer: {
        peerId: "master_peer",
        accountId: "account_1",
        displayName: "Steve",
        status: "connected",
        joinedAt,
      },
      member_peer: {
        peerId: "member_peer",
        accountId: "account_2",
        displayName: "Alex",
        status: input?.memberStatus ?? "negotiating",
        joinedAt: joinedAt + 1,
      },
    },
  };
}

function masterAndMember(
  f: ReturnType<typeof fixture>,
  memberStatus: "negotiating" | "connected" = "negotiating",
) {
  const master = socketWith({
    peerId: "master_peer",
    accountId: "account_1",
    displayName: "Steve",
  });
  const member = socketWith({
    peerId: "member_peer",
    accountId: "account_2",
    displayName: "Alex",
  });
  f.sockets.push(master.socket, member.socket);
  f.values.set("room", roomState({ memberStatus }));
  return { master, member };
}

function assertOnlyCanonicalMessages(messages: Array<{ type: string }>) {
  for (const message of messages) {
    assert.ok(["room-state", "signal", "error"].includes(message.type));
  }
}

Deno.test("MultiplayerRoomObject creates a room on first admission and assigns its master", async () => {
  const f = fixture();
  const expiresAt = Date.now() + 60_000;
  const firstAdmission = {
    roomId: "room_1",
    accountId: "account_1",
    maxPeers: 8,
    createIfMissing: true,
    expiresAt,
  };
  assert.deepEqual(
    await (await f.object.fetch(internal("/admission", firstAdmission))).json(),
    { role: "master", maxPeers: 8, created: true },
  );
  assert.equal(f.alarm, expiresAt);
  assert.deepEqual(
    await (await f.object.fetch(internal("/admission", {
      ...firstAdmission,
      accountId: "account_1",
    }))).json(),
    { role: "master", maxPeers: 8, created: false },
  );
  assert.equal(
    (await f.object.fetch(internal("/admission", {
      ...firstAdmission,
      accountId: "account_2",
    }))).status,
    409,
  );
});

Deno.test("member rtc-state transitions broadcast authoritative snapshots", async () => {
  const f = fixture();
  const { master, member } = masterAndMember(f);

  await f.object.webSocketMessage(
    member.socket,
    JSON.stringify({ type: "rtc-state", state: "connected" }),
  );

  const room = f.values.get("room") as ReturnType<typeof roomState>;
  assert.equal(room.members.member_peer.status, "connected");
  assert.equal(room.revision, 2);
  assert.deepEqual(master.messages().map((message) => message.type), [
    "room-state",
  ]);
  assert.deepEqual(member.messages().map((message) => message.type), [
    "room-state",
  ]);
  const snapshot = member.messages()[0];
  assert.equal(snapshot.selfPeerId, "member_peer");
  assert.equal(snapshot.masterPeerId, "master_peer");
  assert.equal(snapshot.status, "open");
  assert.equal(snapshot.maxPeers, 8);
  assert.equal(snapshot.revision, 2);
  assert.equal(
    snapshot.members.some((current: Record<string, unknown>) =>
      Object.hasOwn(current, "role")
    ),
    false,
  );
  assertOnlyCanonicalMessages([...master.messages(), ...member.messages()]);

  master.clear();
  member.clear();
  await f.object.webSocketMessage(
    member.socket,
    JSON.stringify({ type: "rtc-state", state: "negotiating" }),
  );
  assert.equal(
    (f.values.get("room") as ReturnType<typeof roomState>).members.member_peer
      .status,
    "negotiating",
  );
  assert.deepEqual(master.messages().map((message) => message.type), [
    "room-state",
  ]);
  assert.deepEqual(member.messages().map((message) => message.type), [
    "room-state",
  ]);
});

Deno.test("member join broadcasts one negotiating snapshot", async () => {
  const f = fixture();
  const master = socketWith({
    peerId: "master_peer",
    accountId: "account_1",
    displayName: "Steve",
  });
  const joining = socketWith({
    peerId: "joining_peer",
    accountId: "account_3",
    displayName: "Kai",
  });
  const room = roomState();
  delete room.members.member_peer;
  f.values.set("room", room);
  f.sockets.push(master.socket, joining.socket);
  const joinRoom = f.object as unknown as {
    joinRoom(
      room: TestRoomState,
      peer: Record<string, unknown>,
      role: "master" | "member",
      socket: CfWebSocket,
    ): Promise<void>;
  };

  await joinRoom.joinRoom(
    room,
    joining.socket.deserializeAttachment<Record<string, unknown>>()!,
    "member",
    joining.socket,
  );

  assert.equal(room.members.joining_peer.status, "negotiating");
  assert.equal(room.revision, 2);
  assert.deepEqual(master.messages().map((message) => message.type), [
    "room-state",
  ]);
  assert.deepEqual(joining.messages().map((message) => message.type), [
    "room-state",
  ]);
  assert.deepEqual(
    master.messages()[0].members.map(
      (current: { peerId: string }) => current.peerId,
    ).sort(),
    ["joining_peer", "master_peer"],
  );
});

Deno.test("member socket close removes membership with one snapshot", async () => {
  const f = fixture();
  const { master, member } = masterAndMember(f, "connected");
  member.socket.close(1000, "gone");

  await f.object.webSocketClose(member.socket, 1000, "gone", true);

  const room = f.values.get("room") as ReturnType<typeof roomState>;
  assert.equal(room.members.member_peer, undefined);
  assert.deepEqual(master.messages().map((message) => message.type), [
    "room-state",
  ]);
  assert.deepEqual(
    master.messages()[0].members.map(
      (current: { peerId: string }) => current.peerId,
    ),
    ["master_peer"],
  );
});

Deno.test("master socket close enters waiting-master with one snapshot", async () => {
  const f = fixture();
  const { master, member } = masterAndMember(f, "connected");

  await f.object.webSocketClose(master.socket, 1006, "lost", false);

  assert.equal(master.closed, undefined);
  assert.equal(member.closed, undefined);
  const room = f.values.get("room") as ReturnType<typeof roomState>;
  assert.equal(room.status, "waiting-master");
  assert.equal(room.members.master_peer.status, "negotiating");
  assert.equal(room.members.member_peer.status, "negotiating");
  assert.ok(f.alarm && f.alarm <= Date.now() + 30_000);
  assert.deepEqual(member.messages().map((message) => message.type), [
    "room-state",
  ]);
  assert.equal(member.messages()[0].status, "waiting-master");
});

Deno.test("master transfer persists once and broadcasts only one topology snapshot", async () => {
  const f = fixture();
  const { master, member } = masterAndMember(f, "connected");
  f.resetRoomPuts();

  await f.object.webSocketMessage(
    master.socket,
    JSON.stringify({ type: "transfer-master", peerId: "member_peer" }),
  );

  const room = f.values.get("room") as ReturnType<typeof roomState>;
  assert.equal(f.roomPuts, 1);
  assert.equal(room.revision, 2);
  assert.equal(room.masterPeerId, "member_peer");
  assert.equal(room.masterAccountId, "account_2");
  assert.equal(room.members.master_peer.status, "negotiating");
  assert.equal(room.members.member_peer.status, "connected");
  assert.deepEqual(master.messages().map((message) => message.type), [
    "room-state",
  ]);
  assert.deepEqual(member.messages().map((message) => message.type), [
    "room-state",
  ]);

  assert.deepEqual(
    await (await f.object.fetch(internal("/admission", {
      roomId: "room_1",
      accountId: "account_2",
      createIfMissing: false,
    }))).json(),
    { role: "master", maxPeers: 8, created: false },
  );
  assert.deepEqual(
    await (await f.object.fetch(internal("/admission", {
      roomId: "room_1",
      accountId: "account_1",
      createIfMissing: false,
    }))).json(),
    { role: "member", maxPeers: 8, created: false },
  );

  master.clear();
  member.clear();
  await f.object.webSocketMessage(
    master.socket,
    JSON.stringify({ type: "signal", payload: { candidate: "ice" } }),
  );
  assert.deepEqual(member.messages()[0], {
    type: "signal",
    sender: "master_peer",
    payload: { candidate: "ice" },
  });
  await f.object.webSocketMessage(
    member.socket,
    JSON.stringify({
      type: "signal",
      receiver: "master_peer",
      payload: { answer: "sdp" },
    }),
  );
  assert.deepEqual(master.messages()[0], {
    type: "signal",
    sender: "member_peer",
    payload: { answer: "sdp" },
  });
});

Deno.test("master reconnect with a new peer id rebuilds topology in one snapshot", async () => {
  const f = fixture();
  const { master, member } = masterAndMember(f, "connected");
  const reconnected = socketWith({
    peerId: "new_master_peer",
    accountId: "account_1",
    displayName: "Steve",
  });
  f.sockets.push(reconnected.socket);
  f.resetRoomPuts();
  const peer = reconnected.socket.deserializeAttachment<
    Record<string, unknown>
  >()!;
  const joinRoom = f.object as unknown as {
    joinRoom(
      room: ReturnType<typeof roomState>,
      peer: Record<string, unknown>,
      role: "master" | "member",
      socket: CfWebSocket,
    ): Promise<void>;
  };

  await joinRoom.joinRoom(
    f.values.get("room") as ReturnType<typeof roomState>,
    peer,
    "master",
    reconnected.socket,
  );

  const room = f.values.get("room") as ReturnType<typeof roomState>;
  assert.equal(f.roomPuts, 1);
  assert.equal(room.revision, 2);
  assert.equal(room.masterPeerId, "new_master_peer");
  assert.equal(room.members.master_peer, undefined);
  assert.equal(room.members.new_master_peer.status, "connected");
  assert.equal(room.members.member_peer.status, "negotiating");
  assert.equal(master.closed?.code, 4001);
  assert.deepEqual(member.messages().map((message) => message.type), [
    "room-state",
  ]);
  assert.deepEqual(
    reconnected.messages().map((message) => message.type),
    ["room-state"],
  );
  assert.equal(member.messages()[0].masterPeerId, "new_master_peer");
});

Deno.test("master remove-member closes the target and broadcasts one snapshot", async () => {
  const f = fixture();
  const { master, member } = masterAndMember(f, "connected");
  f.resetRoomPuts();

  await f.object.webSocketMessage(
    master.socket,
    JSON.stringify({ type: "remove-member", peerId: "member_peer" }),
  );

  const room = f.values.get("room") as ReturnType<typeof roomState>;
  assert.equal(f.roomPuts, 1);
  assert.equal(room.members.member_peer, undefined);
  assert.equal(member.closed?.code, 4003);
  assert.deepEqual(master.messages().map((message) => message.type), [
    "room-state",
  ]);
  assert.deepEqual(member.messages(), []);
});

Deno.test("room close emits the canonical closed snapshot before closing sockets", async () => {
  const f = fixture();
  const { master, member } = masterAndMember(f, "connected");

  assert.equal(
    (await f.object.fetch(internal("/close", {
      accountId: "account_1",
    }))).status,
    204,
  );

  for (const peer of [master, member]) {
    assert.deepEqual(peer.events, ["send", "close"]);
    assert.equal(peer.messages().length, 1);
    assert.equal(peer.messages()[0].type, "room-state");
    assert.equal(peer.messages()[0].status, "closed");
    assert.equal(peer.closed?.code, 4000);
  }
  assert.equal(f.values.has("room"), false);
});

Deno.test("legacy and malformed client messages cannot mutate room state", async () => {
  for (
    const legacy of [
      { type: "guest-left", peerId: "member_peer" },
      { type: "kick", peerId: "member_peer" },
      { type: "leave" },
    ]
  ) {
    const f = fixture();
    const { master } = masterAndMember(f, "connected");
    f.resetRoomPuts();
    await f.object.webSocketMessage(master.socket, JSON.stringify(legacy));
    assert.equal(f.roomPuts, 0);
    assert.deepEqual(master.messages(), [{
      type: "error",
      code: "unsupported_message",
    }]);
  }

  for (const malformed of ["null", "[]", "42", '"signal"', "{"]) {
    const f = fixture();
    const { member } = masterAndMember(f);
    await f.object.webSocketMessage(member.socket, malformed);
    assert.equal(member.messages()[0].code, "invalid_message");
  }
});
