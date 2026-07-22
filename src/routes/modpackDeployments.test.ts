import assert from "node:assert/strict";
import { createApp } from "../app.ts";
import { AccountError } from "../lib/account.ts";
import {
  InMemoryM9Repository,
  type ServerCompatibilityGateway,
  type WorkerDeploymentGateway,
} from "../lib/deploymentTasks.ts";
import type { DeploymentManifest } from "../lib/deploymentManifest.ts";
import { createModpackDeploymentRuntime } from "../lib/modpackDeploymentRuntime.ts";
import type { AccountRuntime } from "../lib/accountRuntime.ts";
import { validCompatibility } from "../lib/modpackTestFixtures.ts";

const importBody = {
  sourceFormat: "mrpack",
  expectedSha256: "a".repeat(64),
  expectedSizeBytes: 100,
};

function request(
  path: string,
  token: string,
  body?: unknown,
  idempotencyKey = "m9-test-key",
) {
  return new Request(`http://m9.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(body === undefined ? {} : { "idempotency-key": idempotencyKey }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function accountRuntime(): AccountRuntime {
  return {
    sessions: {
      verify(token: string) {
        const accountId = token === "account-a" || token === "read-only"
          ? "account-a"
          : token === "account-b"
          ? "account-b"
          : undefined;
        if (!accountId) throw new AccountError(401, "authentication_required");
        return Promise.resolve({
          sessionId: `session-${accountId}`,
          familyId: `family-${accountId}`,
          accountId,
          scopes: token === "read-only"
            ? ["modpack:read"]
            : ["modpack:read", "modpack:write"],
          issuedAt: "2026-07-22T14:00:00.000Z",
          expiresAt: "2026-07-23T14:00:00.000Z",
        });
      },
    },
  } as unknown as AccountRuntime;
}

function createMountedM9App(options: {
  includeTarget?: boolean;
  includeStaging?: boolean;
  stopped?: boolean;
} = {}) {
  const repository = new InMemoryM9Repository();
  const target: ServerCompatibilityGateway = {
    getDeploymentTarget(_accountId, serverId) {
      return Promise.resolve({
        serverId,
        accountId: serverId === "server-b" ? "account-b" : "account-a",
        state: options.stopped ? "stopped" : "running",
        compatibility: validCompatibility,
        ...(options.stopped
          ? {
            runtimeStopped: {
              eventType: "runtime.stopped.v1" as const,
              eventId: "runtime_123",
              schemaVersion: 1 as const,
              serverId,
              leaseId: "lease_123",
              settlementId: "settlement_123",
              reason: "balance_exhausted" as const,
              occurredAt: "2026-07-23T00:00:05Z",
            },
          }
          : {}),
      });
    },
  };
  const staging: WorkerDeploymentGateway = {
    createRollbackSnapshot() {
      return Promise.resolve("snapshot_123");
    },
    stageAndVerify() {
      return Promise.resolve({
        stagingId: "staging_123",
        manifestSha256: "a".repeat(64),
      });
    },
    async atomicSwitch() {},
    async restoreSnapshot() {},
  };
  const runtime = createModpackDeploymentRuntime({
    repository,
    archives: {
      createUpload() {
        return Promise.resolve({
          uploadUrl: "https://storage.invalid/m9",
          expiresAt: "2026-07-23T00:00:00.000Z",
          maxSizeBytes: 1024,
        });
      },
      readVerified() {
        return Promise.reject(new Error("unused"));
      },
    },
    dispatcher: { async enqueue() {} },
    resolvers: [],
    now: () => "2026-07-22T14:00:00.000Z",
    id: (() => {
      let index = 0;
      return (prefix) => `${prefix}_${++index}`;
    })(),
  });
  const app = createApp((shared) => {
    shared.use("*", async (c, next) => {
      c.set("accountRuntime", accountRuntime());
      c.set("modpackDeploymentRuntime", runtime);
      if (options.includeTarget !== false) {
        c.set("modpackDeploymentServerControlTarget", target);
      }
      if (options.includeStaging !== false) {
        c.set("modpackDeploymentWorkerStaging", staging);
      }
      await next();
    });
  });
  return { app, repository };
}

function previewedManifest(): DeploymentManifest {
  return {
    manifestVersion: 1,
    deploymentId: "deployment-stopped",
    serverId: "server-a",
    sourceFormat: "mrpack",
    compatibility: validCompatibility,
    configFiles: [],
    dataFiles: [],
    mods: [],
    rollbackSnapshotId: "snapshot_123",
    createdAt: "2026-07-22T14:00:00.000Z",
  };
}

Deno.test("mounted ModpackDeployment routes use Account principal and isolate imports by account", async () => {
  const { app } = createMountedM9App();
  const created = await app.request(
    request("/v1/servers/server-a/modpack-imports", "account-a", importBody),
  );
  const imported = await created.json();
  assert.equal(created.status, 201);

  const otherAccount = await app.request(
    request(`/v1/modpack-imports/${imported.importId}`, "account-b"),
  );
  assert.equal(otherAccount.status, 403);
  assert.equal((await otherAccount.json()).error, "forbidden");
});

Deno.test("mounted ModpackDeployment routes reject missing Account modpack scope", async () => {
  const { app } = createMountedM9App();
  const response = await app.request(
    request("/v1/servers/server-a/modpack-imports", "read-only", importBody),
  );
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "insufficient_scope");
});

Deno.test("mounted ModpackDeployment routes reject D5 stopped targets before queuing apply", async () => {
  const { app, repository } = createMountedM9App({ stopped: true });
  const manifest = previewedManifest();
  await repository.putDeployment({
    deploymentId: manifest.deploymentId,
    importId: "import-stopped",
    serverId: manifest.serverId,
    accountId: "account-a",
    status: "previewed",
    manifest,
    manifestSha256: "a".repeat(64),
    createdAt: manifest.createdAt,
    updatedAt: manifest.createdAt,
  });

  const response = await app.request(
    request(
      `/v1/modpack-deployments/${manifest.deploymentId}/apply`,
      "account-a",
      { manifestSha256: "a".repeat(64) },
    ),
  );
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.error, "server_not_ready");
  assert.equal(body.details.runtimeStopped.eventType, "runtime.stopped.v1");
});

Deno.test("mounted ModpackDeployment routes detect idempotency payload conflicts", async () => {
  const { app } = createMountedM9App();
  const first = await app.request(
    request(
      "/v1/servers/server-a/modpack-imports",
      "account-a",
      importBody,
      "same-key",
    ),
  );
  assert.equal(first.status, 201);
  const conflict = await app.request(
    request(
      "/v1/servers/server-a/modpack-imports",
      "account-a",
      { ...importBody, expectedSizeBytes: 101 },
      "same-key",
    ),
  );
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, "idempotency_conflict");
});

Deno.test("mounted ModpackDeployment routes surface missing ServerControl or Worker adapters as 503", async () => {
  for (
    const options of [
      { includeTarget: false },
      { includeStaging: false },
    ]
  ) {
    const { app } = createMountedM9App(options);
    const response = await app.request(
      request("/v1/servers/server-a/modpack-imports", "account-a", importBody),
    );
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.error, "m9_configuration_error");
  }
});
