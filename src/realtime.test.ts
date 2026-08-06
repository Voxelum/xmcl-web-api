import assert from "node:assert/strict";
import { isRetiredServicePath, matchMultiplayerUpgrade } from "./realtime.ts";

Deno.test("retired service paths are identified before Worker dispatch", () => {
  assert.equal(
    isRetiredServicePath(
      new Request("https://ai.xmcl.app/ai/chat/completions"),
    ),
    true,
  );
  assert.equal(
    isRetiredServicePath(
      new Request("https://signaling.xmcl.app/rtc/official"),
    ),
    false,
  );
});

Deno.test("v1 multiplayer WebSocket paths resolve their room id", () => {
  for (
    const [roomId, expected] of [
      [
        "9e0c6ed7-bc94-4f15-b8b7-fac70d02a0bb",
        "9e0c6ed7-bc94-4f15-b8b7-fac70d02a0bb",
      ],
      ["test", "test"],
      ["My_Room-1", "my_room-1"],
    ]
  ) {
    const request = new Request(
      `wss://signaling.xmcl.app/v1/multiplayer/rooms/${roomId}/socket`,
      { headers: { upgrade: "websocket" } },
    );
    assert.equal(matchMultiplayerUpgrade(request), expected);
  }
});

Deno.test("v1 multiplayer WebSocket paths reject invalid room ids", () => {
  for (
    const roomId of [
      "-room",
      "room.name",
      "room%20name",
      "a".repeat(65),
      "%zz",
    ]
  ) {
    const request = new Request(
      `wss://signaling.xmcl.app/v1/multiplayer/rooms/${roomId}/socket`,
      { headers: { upgrade: "websocket" } },
    );
    assert.equal(matchMultiplayerUpgrade(request), undefined);
  }
});

Deno.test("legacy group paths do not match the multiplayer upgrade", () => {
  const request = new Request(
    "wss://signaling.xmcl.app/group/room-1",
    { headers: { upgrade: "websocket" } },
  );
  assert.equal(matchMultiplayerUpgrade(request), undefined);
});
