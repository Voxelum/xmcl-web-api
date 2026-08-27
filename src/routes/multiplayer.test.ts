import assert from "node:assert/strict";
import { Hono } from "hono";
import type { AccountRuntime } from "../accountRuntime.ts";
import { verifyMultiplayerTicket } from "../multiplayerTicket.ts";
import type { AppEnv } from "../types.ts";
import { createMultiplayerRoutes } from "./multiplayer.ts";

const secret = "multiplayer-test-secret-with-at-least-32-characters";
const rooms = new Map<
  string,
  {
    masterAccountId: string;
    maxPeers: number;
    closed: boolean;
    roomSessionId: string;
  }
>();
const attemptTelemetry = new Map<string, Record<string, unknown>>();
const admissionTelemetry = new Map<string, Record<string, unknown>>();
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
          if (input.createIfMissing !== true) {
            return new Response(null, { status: 404 });
          }
          room = {
            masterAccountId: String(input.accountId),
            maxPeers: Number(input.maxPeers),
            closed: false,
            roomSessionId: "14d26be5-6367-4e5f-9654-129c7da8bf2e",
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
            roomSessionId: room.roomSessionId,
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
app.route(
  "/",
  createMultiplayerRoutes(
    () => Promise.resolve(runtime),
    {
      resolveAttemptTelemetry: () =>
        Promise.resolve({
          record: (attempt) => {
            const id = `${attempt.accountId}:${attempt.attemptId}`;
            if (attemptTelemetry.has(id)) {
              return Promise.resolve("duplicate" as const);
            }
            attemptTelemetry.set(
              id,
              structuredClone(attempt) as unknown as Record<string, unknown>,
            );
            return Promise.resolve("recorded" as const);
          },
        }),
      resolveAdmissionTelemetry: () =>
        Promise.resolve({
          record: (admission) => {
            if (admissionTelemetry.has(admission.admissionId)) {
              return Promise.resolve("duplicate" as const);
            }
            admissionTelemetry.set(
              admission.admissionId,
              structuredClone(admission) as unknown as Record<string, unknown>,
            );
            return Promise.resolve("recorded" as const);
          },
        }),
    },
  ),
);
const env = {
  MULTIPLAYER_ROOMS: namespace,
  MULTIPLAYER_TELEMETRY_RATE_LIMITER: {
    limit: () => Promise.resolve({ success: true }),
  },
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
      body: JSON.stringify({ displayName: "Alex", createIfMissing: false }),
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

Deno.test("multiplayer attempt summaries are authenticated and idempotent", async () => {
  authenticatedAccountId = "acct_telemetry";
  attemptTelemetry.clear();
  const attempt = {
    schemaVersion: 1,
    attemptId: "33333333-3333-4333-8333-333333333333",
    deviceId: "44444444-4444-4444-8444-444444444444",
    launcherSessionId: "55555555-5555-4555-8555-555555555555",
    occurredAt: new Date().toISOString(),
    source: "launcher",
    kind: "peer_connection",
    mode: "manual_offer",
    role: "member",
    outcome: "failed",
    failedStage: "ice_connection",
    failureCode: "ice_connection_failed",
    route: "relay",
    turnSessionId: "66666666-6666-4666-8666-666666666666",
    localCandidateType: "relay",
    remoteCandidateType: "relay",
    networkProtocol: "udp",
    retry: 1,
    launcherVersion: "0.67.2",
    launcherBuild: "1469",
    durationMs: 123,
  };
  const unauthenticated = await app.request(
    "/v1/multiplayer/telemetry/attempts",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedAccountId: "acct_telemetry",
        attempts: [attempt],
      }),
    },
    env,
  );
  assert.equal(unauthenticated.status, 401);
  const rejected = await app.request("/v1/multiplayer/telemetry/attempts", {
    method: "POST",
    headers,
    body: JSON.stringify({
      expectedAccountId: "acct_telemetry",
      attempts: [{ ...attempt, accountId: "acct_forged" }],
    }),
  }, env);
  assert.equal(rejected.status, 400);
  assert.equal(attemptTelemetry.size, 0);

  const mismatched = await app.request("/v1/multiplayer/telemetry/attempts", {
    method: "POST",
    headers,
    body: JSON.stringify({
      expectedAccountId: "acct_previous",
      attempts: [attempt],
    }),
  }, env);
  assert.equal(mismatched.status, 409);
  assert.equal(attemptTelemetry.size, 0);

  const first = await app.request("/v1/multiplayer/telemetry/attempts", {
    method: "POST",
    headers,
    body: JSON.stringify({
      expectedAccountId: "acct_telemetry",
      attempts: [attempt],
    }),
  }, env);
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), { accepted: 1, duplicate: 0 });
  const duplicate = await app.request("/v1/multiplayer/telemetry/attempts", {
    method: "POST",
    headers,
    body: JSON.stringify({
      expectedAccountId: "acct_telemetry",
      attempts: [{ ...attempt, retry: attempt.retry + 1 }],
    }),
  }, env);
  assert.deepEqual(await duplicate.json(), { accepted: 0, duplicate: 1 });
  assert.equal(attemptTelemetry.size, 1);
  const stored = attemptTelemetry.get(
    `acct_telemetry:${attempt.attemptId}`,
  );
  assert.equal(stored?.accountId, "acct_telemetry");
  assert.equal(stored && "expectedAccountId" in stored, false);
  assert.equal(
    JSON.stringify(stored).includes("acct_forged"),
    false,
  );
});

Deno.test("multiplayer attempt summary bodies are bounded", async () => {
  authenticatedAccountId = "acct_telemetry";
  const response = await app.request("/v1/multiplayer/telemetry/attempts", {
    method: "POST",
    headers,
    body: JSON.stringify({ padding: "x".repeat(70_000) }),
  }, env);
  assert.equal(response.status, 413);
});

Deno.test("multiplayer attempt summaries are rate limited per account", async () => {
  authenticatedAccountId = "acct_telemetry_limited";
  attemptTelemetry.clear();
  const keys: string[] = [];
  const response = await app.request("/v1/multiplayer/telemetry/attempts", {
    method: "POST",
    headers,
    body: JSON.stringify({
      expectedAccountId: authenticatedAccountId,
      attempts: [{
        schemaVersion: 1,
        attemptId: "83333333-3333-4333-8333-333333333333",
        deviceId: "84444444-4444-4444-8444-444444444444",
        launcherSessionId: "85555555-5555-4555-8555-555555555555",
        occurredAt: new Date().toISOString(),
        source: "launcher",
        kind: "signaling_socket",
        mode: "official_room",
        role: "member",
        outcome: "failed",
        failedStage: "signaling_socket",
        failureCode: "signaling_open_failed",
        retry: 0,
        launcherVersion: "0.67.2",
        launcherBuild: "1469",
        durationMs: 123,
      }],
    }),
  }, {
    ...env,
    MULTIPLAYER_TELEMETRY_RATE_LIMITER: {
      limit: ({ key }: { key: string }) => {
        keys.push(key);
        return Promise.resolve({ success: false });
      },
    },
  });

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.deepEqual(keys, [
    "multiplayer-telemetry:acct_telemetry_limited",
  ]);
  assert.equal(attemptTelemetry.size, 0);
});

Deno.test("room admission telemetry is server-owned for success and failure", async () => {
  authenticatedAccountId = "acct_signaling";
  admissionTelemetry.clear();
  const missing = await app.request("/v1/multiplayer/rooms/no-such-room/join", {
    method: "POST",
    headers,
    body: JSON.stringify({ displayName: "Alex", createIfMissing: false }),
  }, env);
  assert.equal(missing.status, 404);
  const failure = [...admissionTelemetry.values()][0];
  assert.equal(failure.accountId, "acct_signaling");
  assert.equal(failure.source, "signaling");
  assert.equal(failure.outcome, "failed");
  assert.equal(failure.failureCode, "room_not_found");
  assert.equal("attemptId" in failure, false);

  admissionTelemetry.clear();
  const created = await app.request("/v1/multiplayer/rooms", {
    method: "POST",
    headers,
    body: JSON.stringify({ displayName: "Steve" }),
  }, env);
  assert.equal(created.status, 201);
  const success = [...admissionTelemetry.values()][0];
  assert.equal(success.accountId, "acct_signaling");
  assert.equal(success.source, "signaling");
  assert.equal(success.outcome, "succeeded");
  assert.equal(
    success.roomSessionId,
    "14d26be5-6367-4e5f-9654-129c7da8bf2e",
  );
});

Deno.test("room admission telemetry failures do not break multiplayer", async () => {
  authenticatedAccountId = "acct_signaling";
  const deferred: Promise<unknown>[] = [];
  const backgroundApp = new Hono<AppEnv>();
  backgroundApp.use("*", async (c, next) => {
    c.set("waitUntil", (work) => deferred.push(work));
    await next();
  });
  backgroundApp.route(
    "/",
    createMultiplayerRoutes(
      () => Promise.resolve(runtime),
      {
        resolveAdmissionTelemetry: () =>
          Promise.reject(new Error("telemetry unavailable")),
      },
    ),
  );
  const originalError = console.error;
  const logs: unknown[] = [];
  console.error = (...values: unknown[]) => logs.push(values);
  try {
    const missing = await backgroundApp.request(
      "/v1/multiplayer/rooms/telemetry-failure-missing/join",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          displayName: "Alex",
          createIfMissing: false,
        }),
      },
      env,
    );
    assert.equal(missing.status, 404);
    const created = await backgroundApp.request("/v1/multiplayer/rooms", {
      method: "POST",
      headers,
      body: JSON.stringify({ displayName: "Steve" }),
    }, env);
    assert.equal(created.status, 201);
    assert.equal(deferred.length, 2);
    await Promise.all(deferred);
    assert.equal(logs.length, 2);
    assert.equal(
      logs.every((entry) =>
        JSON.stringify(entry).includes(
          "multiplayer.room_admission_telemetry_failed",
        )
      ),
      true,
    );
  } finally {
    console.error = originalError;
  }
});

Deno.test("first join creates a named room and assigns the master", async () => {
  authenticatedAccountId = "account_named_master";
  const created = await app.request("/v1/multiplayer/rooms/Test/join", {
    method: "POST",
    headers,
    body: JSON.stringify({ displayName: "Steve", createIfMissing: true }),
  }, env);
  assert.equal(created.status, 201);
  const creation = await created.json();
  assert.equal(creation.roomId, "test");
  assert.equal(creation.role, "master");

  authenticatedAccountId = "account_named_member";
  const joined = await app.request("/v1/multiplayer/rooms/test/join", {
    method: "POST",
    headers,
    body: JSON.stringify({ displayName: "Alex", createIfMissing: true }),
  }, env);
  assert.equal(joined.status, 200);
  const admission = await joined.json();
  assert.equal(admission.roomId, "test");
  assert.equal(admission.role, "member");
});

Deno.test("named join requires explicit permission to create a missing room", async () => {
  authenticatedAccountId = "account_missing";
  const response = await app.request("/v1/multiplayer/rooms/missing/join", {
    method: "POST",
    headers,
    body: JSON.stringify({
      displayName: "Steve",
      createIfMissing: false,
    }),
  }, env);
  assert.equal(response.status, 404);
  assert.equal(rooms.has("missing"), false);
});
