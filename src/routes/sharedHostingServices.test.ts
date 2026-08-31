import assert from "node:assert/strict";
import { Hono } from "hono";
import type { AccountRuntime } from "../accountRuntime.ts";
import {
  MemorySharedHostingSchedulerRepository,
  SharedHostingScheduler,
} from "../sharedHostingScheduler.ts";
import type { PublicSharedHostingSubscription } from "../sharedHosting.ts";
import type { AppEnv } from "../types.ts";
import { createSharedHostingRoutes } from "./sharedHosting.ts";
import {
  createSharedHostingServiceRoutes,
  publicService,
} from "./sharedHostingServices.ts";

const subscription: PublicSharedHostingSubscription = {
  subscriptionId: "sub_1",
  accountId: "account_1",
  planId: "shared-small",
  status: "active",
  currentPeriodStartedAt: "2026-07-24T00:00:00.000Z",
  currentPeriodEndsAt: "2026-08-24T00:00:00.000Z",
  createdAt: "2026-07-24T00:00:00.000Z",
  updatedAt: "2026-07-24T00:00:00.000Z",
  plan: {
    planId: "shared-small",
    displayName: "Small",
    memoryMiB: 4096,
    sharedCpu: 2,
    persistentStorageGiB: 32,
    monthlyBaseMinor: 400,
    hourlyRateVersion: 101,
    hourlyAmountMinor: 6,
  },
};

const commands: unknown[] = [];
const scheduler = new SharedHostingScheduler(
  new MemorySharedHostingSchedulerRepository(),
  {
    activeSubscription: async (accountId, subscriptionId) => {
      if (
        accountId !== subscription.accountId ||
        subscriptionId !== subscription.subscriptionId
      ) throw new Error("subscription not found");
      return subscription;
    },
  },
  { dispatch: async (command) => void commands.push(command) },
  undefined,
  {
    region: "sgp",
    now: () => new Date("2026-07-24T00:00:00.000Z"),
    createId: (prefix) => `${prefix}_route`,
  },
);
await scheduler.registerNode({
  nodeId: "node_route",
  region: "sgp",
  status: "ready",
  totalMemoryMiB: 4096,
  totalSharedCpu: 2,
  totalWorkspaceGiB: 32,
});

const runtime = {
  sessions: {
    verify: async () => ({
      accountId: "account_1",
      scopes: ["account:read", "account:write"],
    }),
  },
} as unknown as AccountRuntime;

const app = new Hono<AppEnv>();
app.route(
  "/",
  createSharedHostingServiceRoutes(scheduler, () => Promise.resolve(runtime)),
);

Deno.test("shared hosting service routes create and start a service without exposing node or object details", async () => {
  const headers = {
    authorization: `Bearer ${"session"}`,
    "content-type": "application/json",
  };
  const created = await app.request("/v1/shared-hosting/services", {
    method: "POST",
    headers: { ...headers, "idempotency-key": "create-service" },
    body: JSON.stringify({ subscriptionId: "sub_1" }),
  });
  assert.equal(created.status, 201);
  const service = await created.json();
  assert.equal(service.status, "ready");
  assert.equal("nodeId" in service, false);
  assert.equal("objectPrefix" in service.workspace, false);

  const started = await app.request(
    `/v1/shared-hosting/services/${service.serviceId}/start`,
    {
      method: "POST",
      headers: { ...headers, "idempotency-key": "start-service" },
    },
  );
  assert.equal(started.status, 202);
  assert.equal((await started.json()).status, "starting");
  assert.equal(commands.length, 1);
});

Deno.test("subscription and service routers authenticate a service request once", async () => {
  let verificationCount = 0;
  const countedRuntime = {
    sessions: {
      verify: async () => {
        verificationCount += 1;
        return {
          accountId: "account_1",
          scopes: ["account:read", "account:write"],
        };
      },
    },
  } as unknown as AccountRuntime;
  const resolve = () => Promise.resolve(countedRuntime);
  const combined = new Hono<AppEnv>();
  combined.route("/", createSharedHostingRoutes(undefined, resolve));
  combined.route(
    "/",
    createSharedHostingServiceRoutes(scheduler, resolve),
  );

  const response = await combined.request("/v1/shared-hosting/services", {
    headers: { authorization: "Bearer session" },
  });

  assert.equal(response.status, 200);
  assert.equal(verificationCount, 1);
});

Deno.test("service responses omit nullable optional persistence fields", () => {
  const service = JSON.parse(JSON.stringify(publicService({
    serviceId: "service_nullable",
    subscriptionId: "sub_1",
    accountId: "account_1",
    planId: "shared-small",
    regionId: "mow",
    status: "ready",
    workspace: {
      revision: 1,
      sizeBytes: 0,
      syncedAt: null,
    },
    storageOverageSince: null,
    storageGraceEndsAt: null,
    statusReason: null,
    retentionStartedAt: null,
    retentionEndsAt: null,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  } as unknown as Parameters<typeof publicService>[0])));
  assert.equal("syncedAt" in service.workspace, false);
  assert.equal("storageOverageSince" in service.workspace, false);
  assert.equal("storageGraceEndsAt" in service.workspace, false);
  assert.equal("statusReason" in service, false);
  assert.equal("retentionStartedAt" in service, false);
  assert.equal("retentionEndsAt" in service, false);
});

Deno.test("service responses expose only the public Minecraft endpoint", () => {
  const service = publicService(
    {
      serviceId: "service_endpoint",
      subscriptionId: "sub_1",
      accountId: "account_1",
      planId: "shared-small",
      regionId: "mow",
      status: "running",
      workspace: {
        revision: 1,
        sizeBytes: 1024,
        objectPrefix: "shared-hosting/account_1/service_endpoint/",
      },
      nodeId: "ln-mow-camp-1",
      assignmentId: "assignment_1",
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:01:00.000Z",
    },
    undefined,
    { host: "38.60.218.60", port: 25645 },
  );

  assert.deepEqual(service.endpoint, {
    host: "38.60.218.60",
    port: 25645,
  });
  assert.equal("nodeId" in service, false);
  assert.equal("assignmentId" in service, false);
});
