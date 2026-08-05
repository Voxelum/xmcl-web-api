import assert from "node:assert/strict";
import { isRetiredServicePath, matchMultiplayerUpgrade } from "./match.ts";

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
  const roomId = "9e0c6ed7-bc94-4f15-b8b7-fac70d02a0bb";
  const request = new Request(
    `wss://signaling.xmcl.app/v1/multiplayer/rooms/${roomId}/socket`,
    { headers: { upgrade: "websocket" } },
  );
  assert.equal(matchMultiplayerUpgrade(request), roomId);
});

Deno.test("v1 multiplayer WebSocket paths reject non-UUID room ids", () => {
  for (
    const roomId of [
      "room-1",
      "9e0c6ed7-bc94-4f15-b8b7-fac70d02a0b",
      "9e0c6ed7-bc94-4f15-b8b7-fac70d02a0bb-extra",
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
