import assert from "node:assert/strict";
import { Hono } from "hono";
import type { AccountRuntime } from "../lib/accountRuntime.ts";
import { verifyMultiplayerTicket } from "../lib/multiplayerTicket.ts";
import type { AppEnv } from "../types.ts";
import { createMultiplayerRoutes } from "./multiplayer.ts";

const secret = "multiplayer-test-secret-with-at-least-32-characters";
const rooms = new Map<string, { ownerId: string; closed: boolean }>();
const calls: string[] = [];
const namespace = {
  idFromName: (name: string) => name,
  get: (roomId: string) => ({
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      calls.push(path);
      const input = request.body
        ? await request.json() as Record<string, string>
        : {};
      if (path === "/v2/initialize") {
        rooms.set(roomId, { ownerId: input.ownerId, closed: false });
        return new Response(null, { status: 204 });
      }
      const room = rooms.get(roomId);
      if (!room) return new Response(null, { status: 404 });
      if (path === "/v2/admission") {
        return room.closed
          ? new Response(null, { status: 410 })
          : Response.json({
            role: input.accountId === room.ownerId ? "host" : "guest",
          });
      }
      if (path === "/v2/close") {
        if (input.accountId !== room.ownerId) {
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
    verify: async () => ({
      accountId: authenticatedAccountId,
      scopes: ["account:read"],
    }),
  },
} as unknown as AccountRuntime;
const app = new Hono<AppEnv>();
app.route("/", createMultiplayerRoutes(async () => runtime));
const env = {
  MULTIPLAYER_ROOM: namespace,
  XMCL_MULTIPLAYER_TICKET_SECRET: secret,
};
const headers = {
  authorization: "Bearer session",
  "content-type": "application/json",
};

Deno.test("multiplayer routes create, join, and close a Durable Object room", async () => {
  const created = await app.request("/v1/multiplayer/rooms", {
    method: "POST",
    headers,
    body: JSON.stringify({ displayName: "Steve", maxPeers: 4 }),
  }, env);
  assert.equal(created.status, 201);
  const creation = await created.json();
  assert.equal(creation.maxPeers, 4);
  const owner = await verifyMultiplayerTicket(creation.ticket, secret);
  assert.equal(owner?.roomId, creation.roomId);
  assert.equal(owner?.role, "host");

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
  const member = await verifyMultiplayerTicket(
    (await joined.json()).ticket,
    secret,
  );
  assert.equal(member?.role, "guest");

  authenticatedAccountId = "account_1";
  const closed = await app.request(
    `/v1/multiplayer/rooms/${creation.roomId}`,
    { method: "DELETE", headers },
    env,
  );
  assert.equal(closed.status, 204);
  assert.deepEqual(calls, ["/v2/initialize", "/v2/admission", "/v2/close"]);
});

Deno.test("multiplayer routes reject invalid room settings before creating a DO", async () => {
  const response = await app.request("/v1/multiplayer/rooms", {
    method: "POST",
    headers,
    body: JSON.stringify({ displayName: "Steve", maxPeers: 100 }),
  }, env);
  assert.equal(response.status, 400);
});
