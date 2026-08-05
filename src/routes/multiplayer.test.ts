import assert from "node:assert/strict";
import { Hono } from "hono";
import type { AccountRuntime } from "../lib/accountRuntime.ts";
import { verifyMultiplayerTicket } from "../lib/multiplayerTicket.ts";
import type { AppEnv } from "../types.ts";
import { createMultiplayerRoutes } from "./multiplayer.ts";

const secret = "multiplayer-test-secret-with-at-least-32-characters";
const rooms = new Map<
  string,
  { masterAccountId: string; maxPeers: number; closed: boolean }
>();
const calls: string[] = [];
const namespace = {
  idFromName: (name: string) => name,
  get: (roomId: string) => ({
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      calls.push(path);
      const input = request.body
        ? await request.json() as Record<string, unknown>
        : {};
      if (path === "/admission") {
        let room = rooms.get(roomId);
        const created = !room;
        if (!room) {
          room = {
            masterAccountId: String(input.accountId),
            maxPeers: Number(input.maxPeers),
            closed: false,
          };
          rooms.set(roomId, room);
        }
        return room.closed
          ? new Response(null, { status: 410 })
          : Response.json({
            role: input.accountId === room.masterAccountId
              ? "master"
              : "member",
            maxPeers: room.maxPeers,
            created,
          });
      }
      const room = rooms.get(roomId);
      if (!room) return new Response(null, { status: 404 });
      if (path === "/close") {
        if (input.accountId !== room.masterAccountId) {
          return new Response(null, { status: 403 });
        }
        room.closed = true;
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    },
  }),
};
let authenticatedAccountId = "account_1";
const runtime = {
  sessions: {
    verify: () =>
      Promise.resolve({
        accountId: authenticatedAccountId,
        scopes: ["account:read"],
      }),
  },
} as unknown as AccountRuntime;
const app = new Hono<AppEnv>();
app.route("/", createMultiplayerRoutes(() => Promise.resolve(runtime)));
const env = {
  MULTIPLAYER_ROOMS: namespace,
  XMCL_MULTIPLAYER_TICKET_SECRET: secret,
};
const headers = {
  authorization: "Bearer session",
  "content-type": "application/json",
};

Deno.test("multiplayer routes create, join, and close a Durable Object room", async () => {
  authenticatedAccountId = "account_1";
  const created = await app.request("/v1/multiplayer/rooms", {
    method: "POST",
    headers,
    body: JSON.stringify({ displayName: "Steve", maxPeers: 4 }),
  }, env);
  assert.equal(created.status, 201);
  const creation = await created.json();
  assert.equal(creation.maxPeers, 4);
  assert.equal(creation.role, "master");
  const masterClaims = await verifyMultiplayerTicket(creation.ticket, secret);
  assert.equal(masterClaims?.roomId, creation.roomId);
  assert.equal(masterClaims?.role, "master");
  assert.equal(masterClaims?.version, 2);

  authenticatedAccountId = "account_2";
  const joined = await app.request(
    `/v1/multiplayer/rooms/${creation.roomId}/join`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ displayName: "Alex" }),
    },
    env,
  );
  assert.equal(joined.status, 200);
  const joinedAdmission = await joined.json();
  assert.equal(joinedAdmission.role, "member");
  assert.equal(joinedAdmission.maxPeers, 4);
  const member = await verifyMultiplayerTicket(
    joinedAdmission.ticket,
    secret,
  );
  assert.equal(member?.role, "member");
  assert.equal(member?.version, 2);

  authenticatedAccountId = "account_1";
  const closed = await app.request(
    `/v1/multiplayer/rooms/${creation.roomId}`,
    { method: "DELETE", headers },
    env,
  );
  assert.equal(closed.status, 204);
  assert.deepEqual(calls, ["/admission", "/admission", "/close"]);
});

Deno.test("multiplayer routes reject invalid room settings before creating a DO", async () => {
  const response = await app.request("/v1/multiplayer/rooms", {
    method: "POST",
    headers,
    body: JSON.stringify({ displayName: "Steve", maxPeers: 100 }),
  }, env);
  assert.equal(response.status, 400);
});

Deno.test("first join creates a named room and assigns the master", async () => {
  authenticatedAccountId = "account_named_master";
  const created = await app.request("/v1/multiplayer/rooms/Test/join", {
    method: "POST",
    headers,
    body: JSON.stringify({ displayName: "Steve" }),
  }, env);
  assert.equal(created.status, 201);
  const creation = await created.json();
  assert.equal(creation.roomId, "test");
  assert.equal(creation.role, "master");

  authenticatedAccountId = "account_named_member";
  const joined = await app.request("/v1/multiplayer/rooms/test/join", {
    method: "POST",
    headers,
    body: JSON.stringify({ displayName: "Alex" }),
  }, env);
  assert.equal(joined.status, 200);
  const admission = await joined.json();
  assert.equal(admission.roomId, "test");
  assert.equal(admission.role, "member");
});
