import assert from "node:assert/strict";
import {
  isLegacyGroupPath,
  isRetiredServicePath,
  matchMultiplayerUpgrade,
} from "./match.ts";

Deno.test("legacy group paths are identified for early shutdown", () => {
  assert.equal(
    isLegacyGroupPath(new Request("https://signaling.xmcl.app/group/room-1")),
    true,
  );
  assert.equal(
    isLegacyGroupPath(new Request("https://signaling.xmcl.app/group")),
    false,
  );
  assert.equal(
    isLegacyGroupPath(
      new Request("https://signaling.xmcl.app/v1/multiplayer/rooms"),
    ),
    false,
  );
});

Deno.test("retired service paths are identified before Worker dispatch", () => {
  assert.equal(
    isRetiredServicePath(
      new Request("https://ai.xmcl.app/ai/chat/completions"),
    ),
    true,
  );
  assert.equal(
    isRetiredServicePath(
      new Request("https://signaling.xmcl.app/v2/multiplayer/rooms"),
    ),
    true,
  );
  assert.equal(
    isRetiredServicePath(
      new Request("https://signaling.xmcl.app/v1/multiplayer/rooms"),
    ),
    false,
  );
});

Deno.test("v1 multiplayer WebSocket paths resolve their room id", () => {
  const request = new Request(
    "wss://signaling.xmcl.app/v1/multiplayer/rooms/room-1/socket",
    { headers: { upgrade: "websocket" } },
  );
  assert.equal(matchMultiplayerUpgrade(request), "room-1");
});
