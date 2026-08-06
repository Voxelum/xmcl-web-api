import assert from "node:assert/strict";
import {
  signMultiplayerTicket,
  verifyMultiplayerTicket,
} from "./multiplayerTicket.ts";

const secret = "multiplayer-test-secret-with-at-least-32-characters";

Deno.test("multiplayer tickets verify valid claims and reject tampering", async () => {
  const now = Date.now();
  const ticket = await signMultiplayerTicket({
    version: 2,
    roomId: crypto.randomUUID(),
    accountId: "account_1",
    peerId: crypto.randomUUID(),
    displayName: "Steve",
    role: "master",
    issuedAt: now,
    expiresAt: now + 60_000,
  }, secret);

  assert.equal(
    (await verifyMultiplayerTicket(ticket, secret, now))?.accountId,
    "account_1",
  );
  assert.equal(
    await verifyMultiplayerTicket(`${ticket}x`, secret, now),
    undefined,
  );
  assert.equal(
    await verifyMultiplayerTicket(ticket, secret, now + 60_001),
    undefined,
  );
});

Deno.test("multiplayer ticket signing requires a dedicated strong secret", async () => {
  await assert.rejects(
    () =>
      signMultiplayerTicket({
        version: 2,
        roomId: "room",
        accountId: "account",
        peerId: "peer",
        displayName: "Steve",
        role: "member",
        issuedAt: 1,
        expiresAt: 2,
      }, "short"),
    /at least 32 characters/,
  );
});

Deno.test("multiplayer tickets reject old versions and legacy roles", async () => {
  const now = Date.now();
  for (
    const claims of [
      { version: 1, role: "master" },
      { version: 2, role: "host" },
      { version: 2, role: "guest" },
    ]
  ) {
    const ticket = await signMultiplayerTicket({
      version: claims.version as 2,
      roomId: crypto.randomUUID(),
      accountId: "account_1",
      peerId: crypto.randomUUID(),
      displayName: "Steve",
      role: claims.role as "master",
      issuedAt: now,
      expiresAt: now + 60_000,
    }, secret);
    assert.equal(await verifyMultiplayerTicket(ticket, secret, now), undefined);
  }
});
