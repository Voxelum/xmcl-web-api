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
    },
    acceptWebSocket: (socket: CfWebSocket) => sockets.push(socket),
    getWebSockets: () => sockets,
  } satisfies DurableObjectState;
  return {
    object: new MultiplayerRoom(state, {
      XMCL_MULTIPLAYER_TICKET_SECRET: secret,
    }),
    values,
    get alarm() {
      return alarm;
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

Deno.test("MultiplayerRoom initializes once and enforces owner closure", async () => {
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
      accountId: "member_1",
    }))).status,
    200,
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

Deno.test("MultiplayerRoom alarm closes an empty room", async () => {
  const f = fixture();
  await f.object.fetch(internal("/v2/initialize", {
    roomId: "room_1",
    ownerId: "owner_1",
    maxPeers: 8,
    expiresAt: Date.now() + 60_000,
  }));
  await f.object.alarm();
  const room = f.values.get("room") as { status: string };
  assert.equal(room.status, "closed");
  assert.equal(
    (await f.object.fetch(internal("/v2/admission", {
      accountId: "member_1",
    }))).status,
    410,
  );
});
