import assert from "node:assert/strict";
import type { AccountSessionGateway } from "../lib/serverControlProposals.ts";
import {
  ServerControlError,
  type ServerControlService,
} from "../lib/serverControl.ts";
import type { ServerRecord, ServerTask } from "../lib/serverRepository.ts";
import { createServerRoutes } from "./servers.ts";

const server: ServerRecord = {
  serverId: "server_route_fixture",
  accountId: "acct_route_fixture",
  provider: "vultr",
  region: "taipei",
  plan: "vc2-2c-4gb",
  status: "stopped",
  desiredStatus: "stopped",
  statusVersion: 2,
  statusReason: "provider_ready",
  commandSource: "reconciler",
  taskId: "task_route_fixture",
  providerResourceId: "must-not-be-public",
  lastWorkerSequence: 0,
  lastM3Sequence: 0,
  lastM7Sequence: 0,
  createdAt: "2026-07-22T14:00:00.000Z",
  updatedAt: "2026-07-22T14:01:00.000Z",
};

const task: ServerTask = {
  taskId: "task_route_fixture",
  requestId: "request_route_fixture",
  accountId: "acct_route_fixture",
  status: "queued",
  operation: "create",
  resource: { type: "server", id: server.serverId },
  authorizationId: "must-not-be-public",
  createdAt: "2026-07-22T14:00:00.000Z",
  updatedAt: "2026-07-22T14:00:00.000Z",
};

const sessions: AccountSessionGateway = {
  authenticate(authorization) {
    if (authorization === "Bearer control") {
      return Promise.resolve({
        accountId: "acct_route_fixture",
        scopes: ["servers:*"],
      });
    }
    if (authorization === "Bearer read") {
      return Promise.resolve({
        accountId: "acct_route_fixture",
        scopes: ["servers:read", "tasks:read"],
      });
    }
    if (authorization === "Bearer other-account") {
      return Promise.resolve({
        accountId: "acct_other",
        scopes: ["servers:*"],
      });
    }
    return Promise.resolve(null);
  },
};

const fakeService = {
  list(accountId: string) {
    return Promise.resolve(accountId === server.accountId ? [server] : []);
  },
  get(accountId: string, serverId: string) {
    if (accountId !== server.accountId || serverId !== server.serverId) {
      return Promise.reject(new ServerControlError("not_found"));
    }
    return Promise.resolve(server);
  },
  getTask(accountId: string, taskId: string) {
    if (accountId !== task.accountId || taskId !== task.taskId) {
      return Promise.reject(new ServerControlError("not_found"));
    }
    return Promise.resolve(task);
  },
  create() {
    return Promise.resolve(task);
  },
  start() {
    return Promise.resolve({ ...task, operation: "start" });
  },
  stop() {
    return Promise.resolve({ ...task, operation: "stop" });
  },
  restart() {
    return Promise.resolve({ ...task, operation: "restart" });
  },
  delete() {
    return Promise.resolve({ ...task, operation: "delete" });
  },
} as unknown as ServerControlService;

const app = createServerRoutes({ service: fakeService, sessions });

Deno.test("server routes require an Account session and the correct authorization scope", async () => {
  const unauthorized = await app.request("/v1/servers", {
    headers: { "X-Request-Id": "request-unauthorized" },
  });
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), {
    error: "forbidden",
    message: "XMCL account session required",
    requestId: "request-unauthorized",
  });

  const forbidden = await app.request("/v1/servers", {
    method: "POST",
    headers: {
      "Authorization": "Bearer read",
      "Content-Type": "application/json",
      "Idempotency-Key": "route-key",
    },
    body: JSON.stringify({ plan: "vc2-2c-4gb" }),
  });
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).error, "forbidden");
});

Deno.test("mutating routes require Idempotency-Key and return AsyncTask-shaped 202 responses", async () => {
  const missingKey = await app.request("/v1/servers", {
    method: "POST",
    headers: {
      "Authorization": "Bearer control",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ plan: "vc2-2c-4gb" }),
  });
  assert.equal(missingKey.status, 400);
  assert.equal((await missingKey.json()).error, "invalid_request");

  const accepted = await app.request("/v1/servers", {
    method: "POST",
    headers: {
      "Authorization": "Bearer control",
      "Content-Type": "application/json",
      "Idempotency-Key": "route-key",
      "X-Request-Id": "request-route",
    },
    body: JSON.stringify({ plan: "vc2-2c-4gb" }),
  });
  assert.equal(accepted.status, 202);
  const body = await accepted.json();
  assert.equal(body.taskId, task.taskId);
  assert.equal(body.status, "queued");
  assert.equal("authorizationId" in body, false);
  assert.equal("accountId" in body, false);
});

Deno.test("server reads are account-scoped and never expose Vultr resource IDs", async () => {
  const response = await app.request(
    `/v1/servers/${server.serverId}`,
    { headers: { "Authorization": "Bearer read" } },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.serverId, server.serverId);
  assert.equal("providerResourceId" in body, false);

  const crossAccount = await app.request(
    `/v1/servers/${server.serverId}`,
    { headers: { "Authorization": "Bearer other-account" } },
  );
  assert.equal(crossAccount.status, 404);
});
