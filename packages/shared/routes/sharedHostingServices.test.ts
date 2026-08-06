import assert from "node:assert/strict";
import { Hono } from "hono";
import type { AccountRuntime } from "../lib/accountRuntime.ts";
import {
  MemorySharedHostingSchedulerRepository,
  SharedHostingScheduler,
} from "../lib/sharedHostingScheduler.ts";
import type { PublicSharedHostingSubscription } from "../lib/sharedHosting.ts";
import type { AppEnv } from "../types.ts";
import { createSharedHostingServiceRoutes } from "./sharedHostingServices.ts";

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
    burstCpu: 4,
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
