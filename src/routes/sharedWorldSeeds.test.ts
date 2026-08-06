import assert from "node:assert/strict";
import { Hono } from "hono";
import type { AccountRuntime } from "../accountRuntime.ts";
import {
  MemorySharedHostingSchedulerRepository,
  SharedHostingScheduler,
} from "../sharedHostingScheduler.ts";
import {
  MemorySharedWorldSeedRepository,
  SharedWorldSeedService,
} from "../sharedWorldSeed.ts";
import type { AppEnv } from "../types.ts";
import { createSharedWorldSeedRoutes } from "./sharedWorldSeeds.ts";

const hash = "a".repeat(64);
const runtime = {
  sessions: { verify: async () => ({ accountId: "account_1", scopes: ["account:read", "account:write"] }) },
} as unknown as AccountRuntime;
const scheduler = new SharedHostingScheduler(
  new MemorySharedHostingSchedulerRepository(),
  {
    activeSubscription: async (accountId, subscriptionId) => ({
      subscriptionId, accountId, planId: "shared-small", status: "active",
      currentPeriodStartedAt: "2026-07-25T00:00:00.000Z", currentPeriodEndsAt: "2026-08-25T00:00:00.000Z",
      createdAt: "2026-07-25T00:00:00.000Z", updatedAt: "2026-07-25T00:00:00.000Z",
      plan: { planId: "shared-small", displayName: "small", memoryMiB: 4096, sharedCpu: 2, burstCpu: 4, persistentStorageGiB: 32, monthlyBaseMinor: 1, hourlyRateVersion: 1, hourlyAmountMinor: 1 },
    }),
  },
  { dispatch: async () => undefined },
  undefined,
  { region: "sgp" },
);
const seeds = new SharedWorldSeedService({
  scheduler,
  repository: new MemorySharedWorldSeedRepository(),
  archives: {
    createUpload: async () => ({ uploadUrl: "https://storage.example/exact", expiresAt: "2026-07-25T00:10:00.000Z", maxSizeBytes: 1 }),
    readVerified: async () => new Uint8Array([0]),
  },
});
const app = new Hono<AppEnv>();
app.route("/", createSharedWorldSeedRoutes(seeds, async () => runtime));

Deno.test("world seed routes require account write and never list signed upload URLs", async () => {
  const service = await scheduler.createService({ accountId: "account_1", subscriptionId: "sub_1", idempotencyKey: "service" });
  const headers = { authorization: ["Bearer", "session"].join(" "), "content-type": "application/json", "idempotency-key": "seed" };
  const created = await app.request(`/v1/shared-hosting/services/${service.serviceId}/world-seeds`, {
    method: "POST", headers, body: JSON.stringify({ expectedSha256: hash, expectedSizeBytes: 1 }),
  });
  assert.equal(created.status, 201);
  const listed = await app.request(`/v1/shared-hosting/services/${service.serviceId}/world-seeds`, { headers });
  assert.equal(listed.status, 200);
  const body = await listed.json();
  assert.equal("uploadUrl" in body[0], false);
  const granted = await app.request(`/v1/shared-hosting/world-seeds/${body[0].seedId}/upload-url`, { method: "POST", headers });
  assert.equal(granted.status, 200);
  assert.equal((await granted.json()).uploadUrl, "https://storage.example/exact");
});
