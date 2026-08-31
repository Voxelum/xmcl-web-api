import assert from "node:assert/strict";
import { Hono } from "hono";
import type { AppEnv } from "./types.ts";
import { createSharedNodeTransportRoutes } from "./routes/sharedNodeTransport.ts";
import {
  DurableSharedNodeCommandGateway,
  hashSharedNodeToken,
  MemorySharedNodeCommandOutbox,
  MemorySharedNodeCredentialRepository,
  MemorySharedNodeIngressRepository,
  MemorySharedWorkspaceManifestRepository,
  SHARED_NODE_TRANSPORT_CONTRACT_VERSION,
  SHARED_NODE_WORKSPACE_CONTRACT_VERSION,
  SharedNodeIngressAssignmentProvider,
  SharedNodeTransportError,
  SharedNodeTransportService,
  signSharedNodeRequest,
} from "./sharedNodeTransport.ts";
import {
  MemorySharedHostingSchedulerRepository,
  SharedHostingScheduler,
  type SharedNodeCommand,
} from "./sharedHostingScheduler.ts";

const nowValue = { value: new Date("2026-07-24T00:00:00.000Z") };

function command(nodeId: string, commandId: string): SharedNodeCommand {
  return {
    commandId,
    kind: "workspace.restore_and_start",
    nodeId,
    serviceId: "service_1",
    assignmentId: "assignment_1",
    accountId: "account_1",
    workspace: {
      objectPrefix: "shared-hosting/account_1/service_1/",
      revision: 0,
      sizeBytes: 0,
    },
    resources: {
      memoryMiB: 4096,
      sharedCpu: 2,
      burstCpu: 4,
      workspaceGiB: 32,
    },
    connection: {
      host: `${nodeId.replaceAll("_", "-")}.shared.example`,
      hostPort: 25565,
    },
  };
}

async function signed(
  secret: string,
  authorization: string | undefined,
  method: string,
  path: string,
  body: string,
  nonce: string,
) {
  const timestamp = String(nowValue.value.getTime());
  return {
    method,
    path,
    body,
    authorization,
    timestamp,
    nonce,
    bodyHash: await digest(body),
    signature: await signSharedNodeRequest(secret, {
      method,
      path,
      body,
      timestamp,
      nonce,
    }),
  };
}

async function digest(value: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const heartbeat = {
  contractVersion: SHARED_NODE_TRANSPORT_CONTRACT_VERSION,
  status: "ready" as const,
  capacity: {
    freeWorkspaceGiB: 32,
    allocatableMemoryMiB: 4096,
    allocatableSharedCpu: 2,
    activeContainerCount: 0,
  },
  agentVersion: "test-agent/1",
  ingress: { host: "node.shared.example" },
} as const;

async function fixture() {
  const credentialRepository = new MemorySharedNodeCredentialRepository();
  const ingress = new MemorySharedNodeIngressRepository();
  const outbox = new MemorySharedNodeCommandOutbox();
  const manifests = new MemorySharedWorkspaceManifestRepository();
  const deletedKeys: string[][] = [];
  const schedulerRepository = new MemorySharedHostingSchedulerRepository();
  const scheduler = new SharedHostingScheduler(
    schedulerRepository,
    {
      activeSubscription: async () => {
        throw new Error("unused");
      },
    },
    { dispatch: async () => {} },
    undefined,
    {
      region: "sgp",
      now: () => nowValue.value,
      nodeHeartbeatTimeoutMs: 1_000,
    },
  );
  const service = new SharedNodeTransportService({
    credentialRepository,
    enrollmentRepository: credentialRepository,
    commandOutbox: outbox,
    scheduler,
    now: () => nowValue.value,
    commandLeaseMs: 1_000,
    ingressRepository: ingress,
    workspaceManifestRepository: manifests,
    workspaceSigner: {
      presign: async (key, method, expiresInSeconds) => ({
        key,
        method,
        url:
          `https://xmclcampstaging.blob.core.windows.net/xmcl-shared-hosting/${key}?grant=only`,
        expiresAt: new Date(
          nowValue.value.getTime() + expiresInSeconds * 1_000,
        ).toISOString(),
        ...(method === "PUT" ? { headers: { "if-none-match": "*" } } : {}),
      }),
      deleteExact: async (keys) => void deletedKeys.push([...keys]),
    },
  });
  const registrations = new Map<string, string>();
  for (const nodeId of ["node_a", "node_b"]) {
    const enrollmentToken = `enrollment-${nodeId}`;
    await credentialRepository.saveEnrollment({
      nodeId,
      provisioningRequestId: `request-${nodeId}`,
      instanceId: `instance-${nodeId}`,
      region: "sgp",
      expectedCapacity: {
        totalMemoryMiB: 4096,
        totalSharedCpu: 2,
        totalWorkspaceGiB: 32,
      },
      oneTimeTokenHash: await hashSharedNodeToken(enrollmentToken),
      expiresAt: "2026-07-24T00:30:00.000Z",
    });
    const body = JSON.stringify({
      nodeId,
      instanceId: `instance-${nodeId}`,
      region: "sgp",
      totalMemoryMiB: 4096,
      totalSharedCpu: 2,
      totalWorkspaceGiB: 32,
    });
    const request = await signed(
      enrollmentToken,
      undefined,
      "POST",
      "/v1/internal/shared-nodes/register",
      body,
      `register-${nodeId}`,
    );
    const issued = await service.register(
      JSON.parse(body),
      { ...request, bootstrapCredential: enrollmentToken },
    );
    registrations.set(nodeId, issued.credential);
  }

  return {
    service,
    scheduler,
    registrations,
    credentialRepository,
    ingress,
    outbox,
    manifests,
    deletedKeys,
    schedulerRepository,
  };
}

Deno.test("stop commands preempt queued restore retries", async () => {
  const outbox = new MemorySharedNodeCommandOutbox();
  await outbox.enqueue(command("node_a", "restore"));
  await outbox.enqueue({
    ...command("node_a", "stop"),
    kind: "workspace.stop_and_sync",
  });

  const leased = await outbox.next(
    "node_a",
    "2026-07-24T00:00:00.000Z",
    1_000,
  );

  assert.equal(leased?.command.kind, "workspace.stop_and_sync");
});

Deno.test("retained workspace export grants only the published canonical revision", async (t) => {
  const f = await fixture();
  const prefix = "shared-hosting/account_1/service_retained/";
  const blob = {
    key: `${prefix}revisions/2/world/part-1.tar.zst`,
    sha256: "a".repeat(64),
    compressedSize: 128,
    logicalSize: 256,
    paths: ["world/level.dat"],
  };
  await f.schedulerRepository.transact((state) => {
    state.services.push({
      serviceId: "service_retained",
      accountId: "account_1",
      subscriptionId: "subscription_retained",
      planId: "shared-small",
      regionId: "sgp",
      status: "retained",
      workspace: {
        objectPrefix: prefix,
        revision: 2,
        sizeBytes: 256,
        syncedAt: "2026-08-24T00:00:00.000Z",
      },
      retentionStartedAt: "2026-08-24T00:00:00.000Z",
      retentionEndsAt: "2026-09-23T00:00:00.000Z",
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    });
  });
  await f.manifests.prepare({
    serviceId: "service_retained",
    accountId: "account_1",
    assignmentId: "assignment_retained",
    commandId: "command_retained",
    revision: 2,
    manifest: {
      schemaVersion: 2,
      serviceId: "service_retained",
      assignmentId: "assignment_retained",
      revision: 2,
      createdAt: "2026-08-24T00:00:00.000Z",
      logicalSize: 256,
      manifestHash: "b".repeat(64),
      aggregateSha256: "c".repeat(64),
      world: [blob],
    },
    manifestSha256: "b".repeat(64),
    status: "draft",
    createdAt: "2026-08-24T00:00:00.000Z",
  });

  await t.step(
    "expired retention deletes exact blobs before manifests",
    async () => {
      const f = await fixture();
      const prefix = "shared-hosting/account_1/service_expired/";
      const blobKey = `${prefix}revisions/1/world/part-1.tar.zst`;
      await f.schedulerRepository.transact((state) => {
        state.services.push({
          serviceId: "service_expired",
          accountId: "account_1",
          subscriptionId: "subscription_expired",
          planId: "shared-small",
          regionId: "sgp",
          status: "retained",
          workspace: {
            objectPrefix: prefix,
            revision: 1,
            sizeBytes: 256,
            syncedAt: "2026-08-24T00:00:00.000Z",
          },
          retentionStartedAt: "2026-08-24T00:00:00.000Z",
          retentionEndsAt: "2026-09-23T00:00:00.000Z",
          createdAt: "2026-07-24T00:00:00.000Z",
          updatedAt: "2026-08-24T00:00:00.000Z",
        });
      });
      await f.manifests.prepare({
        serviceId: "service_expired",
        accountId: "account_1",
        assignmentId: "assignment_expired",
        commandId: "command_expired",
        revision: 1,
        manifest: {
          schemaVersion: 2,
          serviceId: "service_expired",
          assignmentId: "assignment_expired",
          revision: 1,
          createdAt: "2026-08-24T00:00:00.000Z",
          logicalSize: 256,
          manifestHash: "b".repeat(64),
          aggregateSha256: "c".repeat(64),
          world: [{
            key: blobKey,
            sha256: "a".repeat(64),
            compressedSize: 128,
            logicalSize: 256,
            paths: ["world/level.dat"],
          }],
        },
        manifestSha256: "b".repeat(64),
        status: "draft",
        createdAt: "2026-08-24T00:00:00.000Z",
      });
      await f.manifests.markPublished({
        serviceId: "service_expired",
        assignmentId: "assignment_expired",
        revision: 1,
      });
      const previousNow = nowValue.value;
      try {
        nowValue.value = new Date("2026-09-24T00:00:00.000Z");
        f.scheduler.attachRetentionPurger((service) =>
          f.service.purgeRetainedWorkspace(service)
        );
        assert.deepEqual(await f.scheduler.purgeExpiredRetentions(), {
          deleted: ["service_expired"],
          failed: [],
        });
        assert.deepEqual(f.deletedKeys, [[
          blobKey,
          `${prefix}revisions/1/manifest.json`,
        ]]);
        assert.equal(
          (await f.schedulerRepository.read()).services[0].status,
          "deleted",
        );
      } finally {
        nowValue.value = previousNow;
      }
    },
  );
  await f.manifests.markPublished({
    serviceId: "service_retained",
    assignmentId: "assignment_retained",
    revision: 2,
    manifestSha256: "b".repeat(64),
  });

  const exported = await f.service.retainedWorkspaceExport(
    "account_1",
    "service_retained",
  );
  assert.equal(exported.revision, 2);
  assert.deepEqual(
    exported.grants.map((grant) => [grant.kind, grant.method, grant.key]),
    [
      [
        "manifest",
        "GET",
        `${prefix}revisions/2/manifest.json`,
      ],
      ["world", "GET", blob.key],
    ],
  );
});

Deno.test("shared node transport enforces node identity and replay protection", async () => {
  const f = await fixture();
  const nodeA = f.registrations.get("node_a")!;
  const nodeB = f.registrations.get("node_b")!;
  await assert.rejects(
    async () =>
      f.service.heartbeat(
        "node_b",
        heartbeat,
        await signed(
          nodeA.slice(nodeA.indexOf(".") + 1),
          `SharedNode ${nodeA}`,
          "POST",
          "/v1/internal/shared-nodes/node_b/heartbeat",
          "",
          "wrong-node",
        ),
      ),
    (error) =>
      error instanceof SharedNodeTransportError &&
      error.code === "node_conflict",
  );

  const replayed = await signed(
    nodeB,
    `SharedNode ${nodeB}`,
    "POST",
    "/v1/internal/shared-nodes/node_b/heartbeat",
    "",
    "same-request",
  );
  await f.service.heartbeat("node_b", heartbeat, replayed);
  await assert.rejects(
    () => f.service.heartbeat("node_b", heartbeat, replayed),
    (error) =>
      error instanceof SharedNodeTransportError &&
      error.code === "replay_detected",
  );
});

Deno.test("shared node credentials rotate only through an authenticated node request", async () => {
  const f = await fixture();
  const original = f.registrations.get("node_a")!;
  const rotated = await f.service.rotateCredential(
    "node_a",
    await signed(
      original,
      `SharedNode ${original}`,
      "POST",
      "/v1/internal/shared-nodes/node_a/credentials:rotate",
      "",
      "credential-rotate",
    ),
  );
  assert.equal(rotated.nodeId, "node_a");
  assert.notEqual(rotated.credential, original);
  assert.ok(Date.parse(rotated.expiresAt) > nowValue.value.getTime());
  await assert.rejects(
    async () =>
      f.service.heartbeat(
        "node_a",
        heartbeat,
        await signed(
          original,
          `SharedNode ${original}`,
          "POST",
          "/v1/internal/shared-nodes/node_a/heartbeat",
          "",
          "old-credential",
        ),
      ),
    (error) =>
      error instanceof SharedNodeTransportError &&
      error.code === "unauthorized",
  );
});

Deno.test("shared node command leases are durable, ordered, and at-least-once", async () => {
  const f = await fixture();
  const credential = f.registrations.get("node_a")!;
  const secret = credential;
  await f.service.dispatch(command("node_a", "command_1"));
  const firstRequest = await signed(
    secret,
    `SharedNode ${credential}`,
    "POST",
    "/v1/internal/shared-nodes/node_a/commands:next",
    "",
    "next-1",
  );
  const first = await f.service.nextCommand("node_a", firstRequest);
  assert.equal(first?.command.commandId, "command_1");
  assert.ok(first?.leaseToken);
  assert.equal(first?.leaseGeneration, 1);
  const blocked = await f.service.nextCommand(
    "node_a",
    await signed(
      secret,
      `SharedNode ${credential}`,
      "POST",
      "/v1/internal/shared-nodes/node_a/commands:next",
      "",
      "next-2",
    ),
  );
  assert.equal(blocked, undefined);

  const ackBody = JSON.stringify({
    leaseToken: first!.leaseToken,
    leaseGeneration: first!.leaseGeneration,
  });
  await f.service.acknowledge(
    "node_a",
    "command_1",
    first!.leaseToken,
    first!.leaseGeneration,
    await signed(
      secret,
      `SharedNode ${credential}`,
      "POST",
      "/v1/internal/shared-nodes/node_a/commands/command_1/ack",
      ackBody,
      "ack-1",
    ),
  );
  assert.equal(
    await f.service.nextCommand(
      "node_a",
      await signed(
        secret,
        `SharedNode ${credential}`,
        "POST",
        "/v1/internal/shared-nodes/node_a/commands:next",
        "",
        "next-3",
      ),
    ),
    undefined,
  );

  await f.service.dispatch(command("node_a", "command_2"));
  const leased = await f.service.nextCommand(
    "node_a",
    await signed(
      secret,
      `SharedNode ${credential}`,
      "POST",
      "/v1/internal/shared-nodes/node_a/commands:next",
      "",
      "next-4",
    ),
  );
  assert.equal(leased?.command.commandId, "command_2");
  nowValue.value = new Date("2026-07-24T00:00:02.000Z");
  const redelivered = await f.service.nextCommand(
    "node_a",
    await signed(
      secret,
      `SharedNode ${credential}`,
      "POST",
      "/v1/internal/shared-nodes/node_a/commands:next",
      "",
      "next-5",
    ),
  );
  assert.equal(redelivered?.command.commandId, "command_2");
  assert.notEqual(redelivered?.leaseToken, leased?.leaseToken);
  await assert.rejects(
    async () =>
      f.service.acknowledge(
        "node_a",
        "command_2",
        leased!.leaseToken,
        leased!.leaseGeneration,
        await signed(
          secret,
          `SharedNode ${credential}`,
          "POST",
          "/v1/internal/shared-nodes/node_a/commands/command_2/ack",
          JSON.stringify({
            leaseToken: leased!.leaseToken,
            leaseGeneration: leased!.leaseGeneration,
          }),
          "old-ack",
        ),
      ),
    (error) =>
      error instanceof SharedNodeTransportError &&
      error.code === "lease_conflict",
  );

  const redeliveredAckBody = JSON.stringify({
    leaseToken: redelivered!.leaseToken,
    leaseGeneration: redelivered!.leaseGeneration,
  });
  await f.service.acknowledge(
    "node_a",
    "command_2",
    redelivered!.leaseToken,
    redelivered!.leaseGeneration,
    await signed(
      secret,
      `SharedNode ${credential}`,
      "POST",
      "/v1/internal/shared-nodes/node_a/commands/command_2/ack",
      redeliveredAckBody,
      "redelivered-ack",
    ),
  );
  nowValue.value = new Date("2026-07-24T00:00:04.000Z");
  await f.service.dispatch(command("node_a", "command_3"));
  const longLease = await f.service.nextCommand(
    "node_a",
    await signed(
      secret,
      `SharedNode ${credential}`,
      "POST",
      "/v1/internal/shared-nodes/node_a/commands:next",
      "",
      "next-6",
    ),
  );
  const renewBody = JSON.stringify({
    leaseToken: longLease!.leaseToken,
    leaseGeneration: longLease!.leaseGeneration,
  });
  const renewed = await f.service.renewLease(
    "node_a",
    "command_3",
    longLease!.leaseToken,
    longLease!.leaseGeneration,
    await signed(
      secret,
      `SharedNode ${credential}`,
      "POST",
      "/v1/internal/shared-nodes/node_a/commands/command_3/lease-renew",
      renewBody,
      "renew-1",
    ),
  );
  assert.equal(renewed.leaseExpiresAt, "2026-07-24T00:00:05.000Z");
});

Deno.test("initial-world restore grants only the selected seed object", async () => {
  const f = await fixture();
  const credential = f.registrations.get("node_a")!;
  const initialWorld = {
    seedId: "seed_1",
    sha256: "a".repeat(64),
    sizeBytes: 42,
    worldName: "Selected World",
  };
  await f.service.dispatch({
    ...command("node_a", "initial-world-command"),
    initialWorld,
  });
  const leased = await f.service.nextCommand(
    "node_a",
    await signed(
      credential,
      `SharedNode ${credential}`,
      "POST",
      "/v1/internal/shared-nodes/node_a/commands:next",
      "",
      "initial-world-next",
    ),
  );
  const key =
    "shared-hosting/account_1/service_1/world-seeds/seed_1.xmcl-world-seed";
  const input = {
    contractVersion: SHARED_NODE_WORKSPACE_CONTRACT_VERSION as 2,
    commandId: leased!.command.commandId,
    assignmentId: leased!.command.assignmentId,
    leaseToken: leased!.leaseToken,
    leaseGeneration: leased!.leaseGeneration,
    stage: "initial-world" as const,
    keys: [key],
  };
  const grants = await f.service.workspaceRestoreGrant(
    "node_a",
    input,
    await signed(
      credential,
      `SharedNode ${credential}`,
      "POST",
      "/v1/internal/shared-nodes/node_a/workspace-grants/restore",
      JSON.stringify(input),
      "initial-world-grant",
    ),
  );
  assert.deepEqual(grants.grants.map((grant) => grant.key), [key]);
  await assert.rejects(
    async () =>
      f.service.workspaceRestoreGrant(
        "node_a",
        {
          ...input,
          keys: [
            "shared-hosting/account_1/service_1/world-seeds/other.xmcl-world-seed",
          ],
        },
        await signed(
          credential,
          `SharedNode ${credential}`,
          "POST",
          "/v1/internal/shared-nodes/node_a/workspace-grants/restore",
          JSON.stringify({
            ...input,
            keys: [
              "shared-hosting/account_1/service_1/world-seeds/other.xmcl-world-seed",
            ],
          }),
          "initial-world-wrong-key",
        ),
      ),
    SharedNodeTransportError,
  );
});

Deno.test("one-time enrollment binds node identity and cannot replace an active credential", async () => {
  const f = await fixture();
  const token = "single-use-node-token";
  await f.credentialRepository.saveEnrollment({
    nodeId: "node_c",
    provisioningRequestId: "request-c",
    instanceId: "instance-c",
    region: "sgp",
    expectedCapacity: {
      totalMemoryMiB: 4096,
      totalSharedCpu: 2,
      totalWorkspaceGiB: 32,
    },
    oneTimeTokenHash: await hashSharedNodeToken(token),
    expiresAt: "2026-07-24T00:30:00.000Z",
  });
  const body = JSON.stringify({
    nodeId: "node_c",
    instanceId: "instance-c",
    region: "sgp",
    totalMemoryMiB: 4096,
    totalSharedCpu: 2,
    totalWorkspaceGiB: 32,
  });
  const wrongInstanceBody = body.replace("instance-c", "instance-other");
  const wrongInstanceRequest = await signed(
    token,
    undefined,
    "POST",
    "/v1/internal/shared-nodes/register",
    wrongInstanceBody,
    "register-c-wrong-instance",
  );
  await assert.rejects(
    () =>
      f.service.register(JSON.parse(wrongInstanceBody), {
        ...wrongInstanceRequest,
        bootstrapCredential: token,
      }),
    (error) =>
      error instanceof SharedNodeTransportError &&
      error.code === "unauthorized",
  );
  const request = await signed(
    token,
    undefined,
    "POST",
    "/v1/internal/shared-nodes/register",
    body,
    "register-c",
  );
  const issued = await f.service.register(
    JSON.parse(body),
    { ...request, bootstrapCredential: token },
  );
  assert.equal(issued.nodeId, "node_c");
  const retryRequest = await signed(
    token,
    undefined,
    "POST",
    "/v1/internal/shared-nodes/register",
    body,
    "register-c-retry",
  );
  const retried = await f.service.register(
    JSON.parse(body),
    { ...retryRequest, bootstrapCredential: token },
  );
  assert.equal(retried.nodeId, "node_c");
  assert.notEqual(retried.credential, issued.credential);
  const replacementToken = "replacement-node-token";
  await f.credentialRepository.saveEnrollment({
    nodeId: "node_c",
    provisioningRequestId: "request-c-replacement",
    instanceId: "instance-c",
    region: "sgp",
    expectedCapacity: {
      totalMemoryMiB: 4096,
      totalSharedCpu: 2,
      totalWorkspaceGiB: 32,
    },
    oneTimeTokenHash: await hashSharedNodeToken(replacementToken),
    expiresAt: "2026-07-24T00:30:00.000Z",
  });
  const replacementRequest = await signed(
    replacementToken,
    undefined,
    "POST",
    "/v1/internal/shared-nodes/node_c/register",
    body,
    "register-c-replacement",
  );
  await assert.rejects(
    async () =>
      f.service.register(
        JSON.parse(body),
        {
          ...replacementRequest,
          bootstrapCredential: replacementToken,
        },
      ),
    (error) =>
      error instanceof SharedNodeTransportError &&
      error.code === "node_conflict",
  );
});

Deno.test("shared node registration accepts only the configured generic pool region", async () => {
  const f = await fixture();
  for (const region of ["taipei", "ewr", "sgp!"]) {
    await assert.rejects(
      () =>
        f.service.register(
          {
            nodeId: `rejected-${region}`,
            instanceId: `instance-rejected-${region}`,
            region,
            totalMemoryMiB: 4096,
            totalSharedCpu: 2,
            totalWorkspaceGiB: 32,
          },
          {
            method: "POST",
            path: "/v1/internal/shared-nodes/register",
            body: "",
          },
        ),
      (error) =>
        error instanceof SharedNodeTransportError &&
        error.code === "invalid_request",
    );
    assert.equal(await f.scheduler.hasNode(`rejected-${region}`), false);
  }
});

Deno.test("shared node routes verify the exact signed HTTP body", async () => {
  const f = await fixture();
  const app = new Hono<AppEnv>();
  app.route("/", createSharedNodeTransportRoutes(f.service));
  const body = JSON.stringify({
    nodeId: "node_route",
    instanceId: "instance-route",
    region: "sgp",
    totalMemoryMiB: 4096,
    totalSharedCpu: 2,
    totalWorkspaceGiB: 32,
  });
  const enrollmentToken = "enrollment-route";
  await f.credentialRepository.saveEnrollment({
    nodeId: "node_route",
    provisioningRequestId: "request-route",
    instanceId: "instance-route",
    region: "sgp",
    expectedCapacity: {
      totalMemoryMiB: 4096,
      totalSharedCpu: 2,
      totalWorkspaceGiB: 32,
    },
    oneTimeTokenHash: await hashSharedNodeToken(enrollmentToken),
    expiresAt: "2026-07-24T00:30:00.000Z",
  });
  const path = "/v1/internal/shared-nodes/register";
  const registration = await signed(
    enrollmentToken,
    `SharedNode-Bootstrap ${enrollmentToken}`,
    "POST",
    path,
    body,
    "route-register",
  );
  const response = await app.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      body,
      headers: {
        authorization: registration.authorization!,
        "x-xmcl-timestamp": registration.timestamp!,
        "x-xmcl-nonce": registration.nonce!,
        "x-xmcl-body-sha256": registration.bodyHash!,
        "x-xmcl-signature": registration.signature!,
      },
    }),
  );
  assert.equal(response.status, 201);
  const issued = await response.json();
  const heartbeatPath = "/v1/internal/shared-nodes/node_route/heartbeat";
  const heartbeatBody = JSON.stringify(heartbeat);
  const signedHeartbeat = await signed(
    issued.credential,
    `SharedNode ${issued.credential}`,
    "POST",
    heartbeatPath,
    heartbeatBody,
    "route-heartbeat",
  );
  const heartbeatResponse = await app.fetch(
    new Request(`http://localhost${heartbeatPath}`, {
      method: "POST",
      body: heartbeatBody,
      headers: {
        authorization: signedHeartbeat.authorization!,
        "x-xmcl-timestamp": signedHeartbeat.timestamp!,
        "x-xmcl-nonce": signedHeartbeat.nonce!,
        "x-xmcl-body-sha256": signedHeartbeat.bodyHash!,
        "x-xmcl-signature": signedHeartbeat.signature!,
      },
    }),
  );
  assert.equal(heartbeatResponse.status, 200);
});

Deno.test("staging operator creates one bounded preprovisioned enrollment", async () => {
  const f = await fixture();
  const app = new Hono<AppEnv>();
  app.route("/", createSharedNodeTransportRoutes(f.service));
  const path = "/v1/staging/shared-nodes/enrollments";
  const body = JSON.stringify({
    nodeId: "node_staging",
    provisioningRequestId: "staging-request-1",
    instanceId: "ecs-staging-1",
    region: "sgp",
    expectedCapacity: {
      workloadClasses: ["standard"],
      totalMemoryMiB: 1536,
      totalSharedCpu: 1,
      totalWorkspaceGiB: 24,
    },
  });
  const previousEnvironment = Deno.env.get("XMCL_DEPLOYMENT_ENVIRONMENT");
  const previousToken = Deno.env.get("XMCL_STAGING_NODE_OPERATOR_TOKEN");
  try {
    Deno.env.set("XMCL_DEPLOYMENT_ENVIRONMENT", "staging");
    Deno.env.set("XMCL_STAGING_NODE_OPERATOR_TOKEN", "operator-secret");
    const unauthorized = await app.fetch(
      new Request(`http://localhost${path}`, {
        method: "POST",
        body,
        headers: { authorization: "Bearer wrong" },
      }),
    );
    assert.equal(unauthorized.status, 401);

    const response = await app.fetch(
      new Request(`http://localhost${path}`, {
        method: "POST",
        body,
        headers: { authorization: "Bearer operator-secret" },
      }),
    );
    assert.equal(response.status, 201);
    const issued = await response.json();
    assert.equal(issued.nodeId, "node_staging");
    assert.equal(issued.region, "sgp");
    assert.match(issued.bootstrapCredential, /^[a-f0-9]{64}$/);
    assert.equal(
      issued.expiresAt,
      new Date(nowValue.value.getTime() + 15 * 60_000).toISOString(),
    );
    const stored = await f.credentialRepository.findEnrollment("node_staging");
    assert.ok(stored);
    assert.notEqual(stored.oneTimeTokenHash, issued.bootstrapCredential);
    assert.equal(
      stored.oneTimeTokenHash,
      await hashSharedNodeToken(issued.bootstrapCredential),
    );
    assert.deepEqual(stored.expectedCapacity.workloadClasses, ["standard"]);

    const duplicate = await app.fetch(
      new Request(`http://localhost${path}`, {
        method: "POST",
        body,
        headers: { authorization: "Bearer operator-secret" },
      }),
    );
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).error, "node_conflict");

    Deno.env.set("XMCL_DEPLOYMENT_ENVIRONMENT", "production");
    const production = await app.fetch(
      new Request(`http://localhost${path}`, {
        method: "POST",
        body: body.replace("node_staging", "node_production"),
        headers: { authorization: "Bearer operator-secret" },
      }),
    );
    assert.equal(production.status, 401);
  } finally {
    if (previousEnvironment === undefined) {
      Deno.env.delete("XMCL_DEPLOYMENT_ENVIRONMENT");
    } else {
      Deno.env.set("XMCL_DEPLOYMENT_ENVIRONMENT", previousEnvironment);
    }
    if (previousToken === undefined) {
      Deno.env.delete("XMCL_STAGING_NODE_OPERATOR_TOKEN");
    } else {
      Deno.env.set("XMCL_STAGING_NODE_OPERATOR_TOKEN", previousToken);
    }
  }
});

Deno.test("workspace grants are lease-bound, exact, manifest-last, and credential-free", async () => {
  const f = await fixture();
  const credential = f.registrations.get("node_a")!;
  await f.service.dispatch({
    ...command("node_a", "workspace.stop_and_sync:assignment_1"),
    kind: "workspace.stop_and_sync",
  });
  const leased = await f.service.nextCommand(
    "node_a",
    await signed(
      credential,
      `SharedNode ${credential}`,
      "POST",
      "/v1/internal/shared-nodes/node_a/commands:next",
      "",
      "contract-next",
    ),
  );
  const renewal = await f.service.renewLease(
    "node_a",
    "workspace.stop_and_sync:assignment_1",
    leased!.leaseToken,
    leased!.leaseGeneration,
    await signed(
      credential,
      `SharedNode ${credential}`,
      "POST",
      "/v1/internal/shared-nodes/node_a/commands/workspace.stop_and_sync:assignment_1/lease-renew",
      JSON.stringify({
        leaseToken: leased!.leaseToken,
        leaseGeneration: leased!.leaseGeneration,
      }),
      "contract-renew",
    ),
  );
  assert.equal(renewal.contractVersion, SHARED_NODE_TRANSPORT_CONTRACT_VERSION);
  assert.equal(renewal.leaseGeneration, leased!.leaseGeneration);
  assert.equal(typeof renewal.leaseExpiresAt, "string");

  const descriptor = {
    key: "shared-hosting/account_1/service_1/content/" + "a".repeat(64) +
      ".tar.zst",
    sha256: "a".repeat(64),
    compressedSize: 10,
    logicalSize: 1,
    paths: ["mods/stable.jar"],
  };
  const aggregate = await digest(
    `${descriptor.key}\0${descriptor.sha256}\0${descriptor.compressedSize}:${descriptor.logicalSize}\0${
      descriptor.paths[0]
    }\0\n`,
  );
  const manifest = {
    schemaVersion: 2 as const,
    serviceId: "service_1",
    assignmentId: "assignment_1",
    revision: 1,
    createdAt: nowValue.value.toISOString(),
    logicalSize: 1,
    manifestHash: aggregate,
    aggregateSha256: aggregate,
    content: descriptor,
    world: [],
  };
  const syncInput = {
    contractVersion: SHARED_NODE_WORKSPACE_CONTRACT_VERSION as 2,
    commandId: "workspace.stop_and_sync:assignment_1",
    assignmentId: "assignment_1",
    leaseToken: leased!.leaseToken,
    leaseGeneration: leased!.leaseGeneration,
    keys: [descriptor.key],
    manifest,
    manifestSha256: "c".repeat(64),
  };
  const syncBody = JSON.stringify(syncInput);
  const sync = await f.service.workspaceSyncGrant(
    "node_a",
    syncInput,
    await signed(
      credential,
      `SharedNode ${credential}`,
      "POST",
      "/v1/internal/shared-nodes/node_a/workspace-grants/sync",
      syncBody,
      "workspace-sync",
    ),
  );
  assert.equal(sync.contractVersion, SHARED_NODE_WORKSPACE_CONTRACT_VERSION);
  assert.deepEqual(sync.grants.map((grant) => grant.key), [descriptor.key]);
  assert.equal(sync.grants[0].method, "PUT");
  assert.deepEqual(sync.grants[0].headers, { "if-none-match": "*" });
  const foreignContent = {
    ...manifest,
    content: {
      ...descriptor,
      key: "shared-hosting/account_1/other_service/content/" + "a".repeat(64) +
        ".tar.zst",
    },
  };
  foreignContent.aggregateSha256 = "d".repeat(64);
  foreignContent.manifestHash = foreignContent.aggregateSha256;
  await assert.rejects(
    async () =>
      f.service.workspaceSyncGrant(
        "node_a",
        { ...syncInput, manifest: foreignContent },
        await signed(
          credential,
          `SharedNode ${credential}`,
          "POST",
          "/v1/internal/shared-nodes/node_a/workspace-grants/sync",
          JSON.stringify({ ...syncInput, manifest: foreignContent }),
          "workspace-cross-prefix",
        ),
      ),
    SharedNodeTransportError,
  );
  await assert.rejects(
    async () =>
      f.service.workspaceSyncGrant(
        "node_a",
        { ...syncInput, manifest: { ...manifest, revision: 2 } },
        await signed(
          credential,
          `SharedNode ${credential}`,
          "POST",
          "/v1/internal/shared-nodes/node_a/workspace-grants/sync",
          JSON.stringify({
            ...syncInput,
            manifest: { ...manifest, revision: 2 },
          }),
          "workspace-wrong-revision",
        ),
      ),
    SharedNodeTransportError,
  );

  const { keys: _syncKeys, ...publishInput } = syncInput;
  const publishBody = JSON.stringify(publishInput);
  const publish = await f.service.workspacePublishGrant(
    "node_a",
    publishInput,
    await signed(
      credential,
      `SharedNode ${credential}`,
      "POST",
      "/v1/internal/shared-nodes/node_a/workspace-grants/publish",
      publishBody,
      "workspace-publish",
    ),
  );
  assert.deepEqual(publish.grants.map((grant) => grant.key), [
    "shared-hosting/account_1/service_1/revisions/1/manifest.json",
  ]);
  assert.equal(publish.grants[0].method, "PUT");
  await f.manifests.markPublished({
    serviceId: "service_1",
    assignmentId: "assignment_1",
    revision: 1,
    manifestSha256: syncInput.manifestSha256,
  });
  await assert.rejects(
    async () =>
      await f.service.workspaceSyncGrant(
        "node_a",
        syncInput,
        await signed(
          credential,
          `SharedNode ${credential}`,
          "POST",
          "/v1/internal/shared-nodes/node_a/workspace-grants/sync",
          syncBody,
          "workspace-overwrite-published",
        ),
      ),
    SharedNodeTransportError,
  );
  await assert.rejects(
    async () =>
      f.service.workspaceSyncGrant(
        "node_a",
        { ...syncInput, assignmentId: "other_assignment" },
        await signed(
          credential,
          `SharedNode ${credential}`,
          "POST",
          "/v1/internal/shared-nodes/node_a/workspace-grants/sync",
          JSON.stringify({ ...syncInput, assignmentId: "other_assignment" }),
          "workspace-wrong-assignment",
        ),
      ),
    SharedNodeTransportError,
  );
  await assert.rejects(
    async () =>
      await f.service.workspaceSyncGrant(
        "node_a",
        { ...syncInput, leaseGeneration: syncInput.leaseGeneration + 1 },
        await signed(
          credential,
          `SharedNode ${credential}`,
          "POST",
          "/v1/internal/shared-nodes/node_a/workspace-grants/sync",
          JSON.stringify({
            ...syncInput,
            leaseGeneration: syncInput.leaseGeneration + 1,
          }),
          "workspace-wrong-generation",
        ),
      ),
    SharedNodeTransportError,
  );
  const nodeB = f.registrations.get("node_b")!;
  await assert.rejects(
    async () =>
      await f.service.workspaceSyncGrant(
        "node_b",
        syncInput,
        await signed(
          nodeB,
          `SharedNode ${nodeB}`,
          "POST",
          "/v1/internal/shared-nodes/node_b/workspace-grants/sync",
          syncBody,
          "workspace-wrong-node",
        ),
      ),
    SharedNodeTransportError,
  );
  await f.service.acknowledge(
    "node_a",
    "workspace.stop_and_sync:assignment_1",
    leased!.leaseToken,
    leased!.leaseGeneration,
    await signed(
      credential,
      `SharedNode ${credential}`,
      "POST",
      "/v1/internal/shared-nodes/node_a/commands/workspace.stop_and_sync:assignment_1/ack",
      JSON.stringify({
        leaseToken: leased!.leaseToken,
        leaseGeneration: leased!.leaseGeneration,
      }),
      "workspace-ack",
    ),
  );
  await assert.rejects(
    async () =>
      await f.service.workspacePublishGrant(
        "node_a",
        publishInput,
        await signed(
          credential,
          `SharedNode ${credential}`,
          "POST",
          "/v1/internal/shared-nodes/node_a/workspace-grants/publish",
          publishBody,
          "workspace-acknowledged",
        ),
      ),
    SharedNodeTransportError,
  );
  await f.service.dispatch({
    ...command("node_a", "restore_published_command"),
    workspace: {
      objectPrefix: "shared-hosting/account_1/service_1/",
      revision: 1,
      sizeBytes: 1,
      sha256: syncInput.manifestSha256,
    },
  });
  const restoreLease = await f.service.nextCommand(
    "node_a",
    await signed(
      credential,
      `SharedNode ${credential}`,
      "POST",
      "/v1/internal/shared-nodes/node_a/commands:next",
      "",
      "restore-published-next",
    ),
  );
  const restoreInput = {
    contractVersion: SHARED_NODE_WORKSPACE_CONTRACT_VERSION as 2,
    commandId: restoreLease!.command.commandId,
    assignmentId: restoreLease!.command.assignmentId,
    leaseToken: restoreLease!.leaseToken,
    leaseGeneration: restoreLease!.leaseGeneration,
  };
  const restoredManifest = await f.service.workspaceRestoreGrant(
    "node_a",
    restoreInput,
    await signed(
      credential,
      `SharedNode ${credential}`,
      "POST",
      "/v1/internal/shared-nodes/node_a/workspace-grants/restore",
      JSON.stringify(restoreInput),
      "restore-published-manifest",
    ),
  );
  assert.deepEqual(restoredManifest.grants.map((grant) => grant.key), [
    "shared-hosting/account_1/service_1/revisions/1/manifest.json",
  ]);
  const blobInput = {
    ...restoreInput,
    stage: "blobs" as const,
    keys: [descriptor.key],
  };
  const restoredBlob = await f.service.workspaceRestoreGrant(
    "node_a",
    blobInput,
    await signed(
      credential,
      `SharedNode ${credential}`,
      "POST",
      "/v1/internal/shared-nodes/node_a/workspace-grants/restore",
      JSON.stringify(blobInput),
      "restore-published-blob",
    ),
  );
  assert.deepEqual(restoredBlob.grants.map((grant) => grant.key), [
    descriptor.key,
  ]);
  await assert.rejects(
    async () =>
      await f.service.workspaceRestoreGrant(
        "node_a",
        {
          ...blobInput,
          keys: ["shared-hosting/other/service/content/x.tar.zst"],
        },
        await signed(
          credential,
          `SharedNode ${credential}`,
          "POST",
          "/v1/internal/shared-nodes/node_a/workspace-grants/restore",
          JSON.stringify({
            ...blobInput,
            keys: ["shared-hosting/other/service/content/x.tar.zst"],
          }),
          "restore-cross-service",
        ),
      ),
    SharedNodeTransportError,
  );

  const app = new Hono<AppEnv>();
  app.route("/", createSharedNodeTransportRoutes(f.service));
  assert.equal(
    app.routes.some((route) =>
      route.path.includes("object-storage-credentials")
    ),
    false,
  );
});

Deno.test("workspace grant rejects an expired command lease before issuing URLs", async () => {
  const f = await fixture();
  const credential = f.registrations.get("node_a")!;
  await f.service.dispatch({
    ...command("node_a", "expired_workspace_command"),
    kind: "workspace.stop_and_sync",
  });
  const leased = await f.service.nextCommand(
    "node_a",
    await signed(
      credential,
      `SharedNode ${credential}`,
      "POST",
      "/v1/internal/shared-nodes/node_a/commands:next",
      "",
      "expired-workspace-next",
    ),
  );
  nowValue.value = new Date(nowValue.value.getTime() + 2_000);
  const input = {
    contractVersion: SHARED_NODE_WORKSPACE_CONTRACT_VERSION as 2,
    commandId: leased!.command.commandId,
    assignmentId: leased!.command.assignmentId,
    leaseToken: leased!.leaseToken,
    leaseGeneration: leased!.leaseGeneration,
  };
  await assert.rejects(
    async () =>
      await f.service.workspaceSyncGrant(
        "node_a",
        input,
        await signed(
          credential,
          `SharedNode ${credential}`,
          "POST",
          "/v1/internal/shared-nodes/node_a/workspace-grants/sync",
          JSON.stringify(input),
          "expired-workspace-grant",
        ),
      ),
    (error) =>
      error instanceof SharedNodeTransportError &&
      error.code === "lease_conflict",
  );
});

Deno.test("each workspace grant route verifies the exact signed request body", async () => {
  const f = await fixture();
  const credential = f.registrations.get("node_a")!;
  const app = new Hono<AppEnv>();
  app.route("/", createSharedNodeTransportRoutes(f.service));
  const body = JSON.stringify({
    contractVersion: SHARED_NODE_WORKSPACE_CONTRACT_VERSION,
    commandId: "command_1234567890",
    assignmentId: "assignment_1",
    leaseToken: "12345678-1234-1234-1234-123456789abc",
    leaseGeneration: 1,
  });
  for (const operation of ["restore", "sync", "publish"]) {
    const path =
      `/v1/internal/shared-nodes/node_a/workspace-grants/${operation}`;
    const signature = await signed(
      credential,
      `SharedNode ${credential}`,
      "POST",
      path,
      body,
      `tampered-${operation}`,
    );
    const response = await app.fetch(
      new Request(`http://localhost${path}`, {
        method: "POST",
        body: body + " ",
        headers: {
          authorization: signature.authorization!,
          "x-xmcl-timestamp": signature.timestamp!,
          "x-xmcl-nonce": signature.nonce!,
          "x-xmcl-body-sha256": signature.bodyHash!,
          "x-xmcl-signature": signature.signature!,
        },
      }),
    );
    assert.equal(response.status, 401, `${operation} accepted a modified body`);
  }
});

Deno.test("control plane reserves command host ports and rejects missing ingress", async () => {
  const f = await fixture();
  const allocator = new SharedNodeIngressAssignmentProvider(
    f.ingress,
    f.credentialRepository,
    { now: () => nowValue.value, portMin: 25565, portMax: 25566 },
  );
  await assert.rejects(
    () => allocator.reserve(command("node_a", "missing-ingress")),
    SharedNodeTransportError,
  );
  await f.credentialRepository.saveHeartbeat({
    ...heartbeat,
    nodeId: "node_a",
    ingress: { host: "public-node.example" },
    receivedAt: nowValue.value.toISOString(),
  });
  const gateway = new DurableSharedNodeCommandGateway(f.outbox, allocator);
  await gateway.dispatch({
    ...command("node_a", "gateway-command"),
    assignmentId: "gateway-assignment",
    connection: undefined,
  });
  const credential = f.registrations.get("node_a")!;
  const leased = await f.service.nextCommand(
    "node_a",
    await signed(
      credential,
      `SharedNode ${credential}`,
      "POST",
      "/v1/internal/shared-nodes/node_a/commands:next",
      "",
      "gateway-next",
    ),
  );
  assert.equal(leased?.command.connection?.host, "public-node.example");
  assert.ok(leased!.command.connection!.hostPort >= 25565);
  await f.ingress.release(
    "node_a",
    "gateway-assignment",
    nowValue.value.toISOString(),
  );
  const first = await allocator.reserve(command("node_a", "assigned-port-1"));
  assert.equal(first.host, "public-node.example");
  assert.ok(first.hostPort >= 25565 && first.hostPort <= 25566);
  await assert.rejects(
    async () =>
      f.service.started(
        "node_a",
        {
          serviceId: "service_1",
          assignmentId: "assignment_1",
          endpoint: { host: first.host, port: first.hostPort + 1 },
        },
        await signed(
          credential,
          `SharedNode ${credential}`,
          "POST",
          "/v1/internal/shared-nodes/node_a/assignments/assignment_1/started",
          JSON.stringify({
            serviceId: "service_1",
            endpoint: { host: first.host, port: first.hostPort + 1 },
          }),
          "wrong-reported-endpoint",
        ),
      ),
    SharedNodeTransportError,
  );
  const second = await allocator.reserve({
    ...command("node_a", "assigned-port-2"),
    serviceId: "service_2",
    assignmentId: "assignment_2",
  });
  assert.notEqual(second.hostPort, first.hostPort);
  assert.deepEqual(
    await f.service.endpointForService("service_1"),
    { host: "public-node.example", port: first.hostPort },
  );
  await f.ingress.release(
    "node_a",
    "assignment_1",
    nowValue.value.toISOString(),
  );
  const reused = await allocator.reserve({
    ...command("node_a", "assigned-port-3"),
    serviceId: "service_3",
    assignmentId: "assignment_3",
  });
  assert.equal(reused.hostPort, first.hostPort);
});

Deno.test("service metrics are bound to account and assignment", async () => {
  const f = await fixture();
  await f.schedulerRepository.transact((state) => {
    state.services.push({
      serviceId: "service_metrics",
      accountId: "account_1",
      subscriptionId: "subscription_metrics",
      planId: "shared-small",
      regionId: "sgp",
      status: "running",
      nodeId: "node_a",
      assignmentId: "assignment_metrics",
      workspace: {
        objectPrefix: "shared-hosting/account_1/service_metrics/",
        revision: 0,
        sizeBytes: 0,
      },
      createdAt: nowValue.value.toISOString(),
      updatedAt: nowValue.value.toISOString(),
    });
  });
  await f.credentialRepository.saveHeartbeat({
    ...heartbeat,
    nodeId: "node_a",
    services: [{
      serviceId: "service_metrics",
      assignmentId: "assignment_metrics",
      cpuPercent: 37.5,
      memoryUsageMiB: 1536,
      memoryLimitMiB: 4096,
    }],
    receivedAt: nowValue.value.toISOString(),
  });
  assert.deepEqual(
    await f.service.sharedServiceMetrics("account_1", "service_metrics"),
    {
      cpuPercent: 37.5,
      memoryUsageMiB: 1536,
      memoryLimitMiB: 4096,
      observedAt: nowValue.value.toISOString(),
    },
  );
  await assert.rejects(
    () => f.service.sharedServiceMetrics("account_2", "service_metrics"),
  );
});
