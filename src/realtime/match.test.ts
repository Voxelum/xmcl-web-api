import assert from "node:assert/strict";
import { isLegacyGroupPath } from "./match.ts";

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
      new Request("https://signaling.xmcl.app/v2/multiplayer/rooms"),
    ),
    false,
  );
});
