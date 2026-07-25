import assert from "node:assert/strict";
import type { CfWebSocket, DurableObjectState } from "./cf_types.ts";
import { MultiplayerRoom } from "./multiplayer_room.ts";

const secret = "multiplayer-test-secret-with-at-least-32-characters";

function fixture() {
  const values = new Map<string, unknown>();
  let alarm: number | undefined;
  const sockets: CfWebSocket[] = [];
  const state = {
    id: { toString: () => "room" },
    storage: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async <T>(key: string, value: T) => {
        values.set(key, value);
      },
      setAlarm: async (value: number) => {
        alarm = value;
      },
      deleteAlarm: async () => {
        alarm = undefined;
      },
      deleteAll: async () => {
        values.clear();
      },
    },
    acceptWebSocket: (socket: CfWebSocket) => sockets.push(socket),
    getWebSockets: () => sockets,
  } satisfies DurableObjectState;
  return {
    object: new MultiplayerRoom(state, {
      XMCL_MULTIPLAYER_TICKET_SECRET: secret,
    }),
    values,
    sockets,
    get alarm() {
      return alarm;
    },
  };
}

function socketWith(peer: {
  peerId: string;
  accountId: string;
  displayName: string;
  role: "host" | "guest";
}) {
  let attachment: unknown = {
    ...peer,
    joinedAt: Date.now(),
    messageWindowStartedAt: Date.now(),
    messageCount: 0,
  };
  const sent: string[] = [];
  let closed: { code?: number; reason?: string } | undefined;
  const socket: CfWebSocket = {
    accept: () => {},
    send: (message) => sent.push(String(message)),
    close: (code, reason) => {
      closed = { code, reason };
    },
    serializeAttachment: (value) => {
      attachment = value;
    },
    deserializeAttachment: <T>() => attachment as T,
    addEventListener: () => {},
  };
  return {
    socket,
    sent,
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

Deno.test("MultiplayerRoom initializes for a host and enforces owner closure", async () => {
  const f = fixture();
  const expiresAt = Date.now() + 60_000;
  const initialized = await f.object.fetch(internal("/v2/initialize", {
    roomId: "room_1",
    ownerId: "owner_1",
    maxPeers: 8,
    expiresAt,
  }));
  assert.equal(initialized.status, 204);
  assert.equal(f.alarm, expiresAt);
  assert.equal(
    (await f.object.fetch(internal("/v2/admission", {
      accountId: "owner_1",
    }))).status,
    200,
  );
  assert.deepEqual(
    await (await f.object.fetch(internal("/v2/admission", {
      accountId: "owner_1",
    }))).json(),
    { role: "host" },
  );
  assert.equal(
    (await f.object.fetch(internal("/v2/admission", {
      accountId: "member_1",
    }))).status,
    409,
  );
  assert.equal(
    (await f.object.fetch(internal("/v2/close", {
      accountId: "member_1",
    }))).status,
    403,
  );
  assert.equal(
    (await f.object.fetch(internal("/v2/close", {
      accountId: "owner_1",
    }))).status,
    204,
  );
  assert.equal(f.alarm, undefined);
});

Deno.test("MultiplayerRoom alarm closes a room whose host never connected", async () => {
  const f = fixture();
  await f.object.fetch(internal("/v2/initialize", {
    roomId: "room_1",
    ownerId: "owner_1",
    maxPeers: 8,
    expiresAt: Date.now() + 60_000,
  }));
  await f.object.alarm();
  assert.equal(f.values.size, 0);
  assert.equal(
    (await f.object.fetch(internal("/v2/admission", {
      accountId: "member_1",
    }))).status,
    404,
  );
});

Deno.test("MultiplayerRoom only relays guest signaling to the host", async () => {
  const f = fixture();
  const host = socketWith({
    peerId: "host_peer",
    accountId: "owner_1",
    displayName: "Steve",
    role: "host",
  });
  const guest = socketWith({
    peerId: "guest_peer",
    accountId: "account_2",
    displayName: "Alex",
    role: "guest",
  });
  f.sockets.push(host.socket, guest.socket);
  f.values.set("room", {
    roomId: "room_1",
    ownerId: "owner_1",
    hostPeerId: "host_peer",
    status: "open",
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    maxPeers: 8,
    revision: 1,
    guests: {
      guest_peer: {
        peerId: "guest_peer",
        accountId: "account_2",
        displayName: "Alex",
        status: "negotiating",
        joinedAt: Date.now(),
      },
    },
  });

  await f.object.webSocketMessage(
    guest.socket,
    JSON.stringify({
      type: "signal",
      receiver: "another_guest",
      payload: { candidate: "ice" },
    }),
  );
  assert.deepEqual(JSON.parse(host.sent[0]), {
    type: "signal",
    sender: "guest_peer",
    payload: { candidate: "ice" },
  });

  await f.object.webSocketMessage(
    host.socket,
    JSON.stringify({
      type: "signal",
      receiver: "guest_peer",
      payload: { answer: "sdp" },
    }),
  );
  assert.deepEqual(JSON.parse(guest.sent[0]), {
    type: "signal",
    sender: "host_peer",
    payload: { answer: "sdp" },
  });

  await f.object.webSocketMessage(
    guest.socket,
    JSON.stringify({ type: "rtc-ready" }),
  );
  assert.equal(guest.closed?.code, 1000);
  const room = f.values.get("room") as {
    guests: Record<string, { status: string }>;
  };
  assert.equal(room.guests.guest_peer.status, "connected");
});
