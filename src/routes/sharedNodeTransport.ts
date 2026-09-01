import { Hono } from "hono";
import { getConfig } from "../config.ts";
import type { AppEnv } from "../types.ts";
import {
  SHARED_NODE_TRANSPORT_CONTRACT_VERSION,
  type SharedNodeCommandResult,
  type SharedNodeSignedRequest,
  SharedNodeTransportError,
  type SharedNodeTransportService,
} from "../sharedNodeTransport.ts";
import { isSharedNodeRegion } from "../sharedHostingScheduler.ts";

const maxWorkspaceGrantRequestBytes = 1 << 20;

export function createSharedNodeTransportRoutes(
  configured?: SharedNodeTransportService,
) {
  const app = new Hono<AppEnv>();

  app.post("/v1/staging/shared-nodes/enrollments", async (c) => {
    const config = getConfig(c);
    if (
      config.XMCL_DEPLOYMENT_ENVIRONMENT !== "staging" ||
      !config.XMCL_STAGING_NODE_OPERATOR_TOKEN ||
      !await bearerMatches(
        c.req.header("authorization"),
        config.XMCL_STAGING_NODE_OPERATOR_TOKEN,
      )
    ) {
      throw new SharedNodeTransportError("unauthorized");
    }
    const parsed = await rawJson(c, 16 * 1024);
    const body = parsed.value;
    const capacity = record(body.expectedCapacity);
    const result = await serviceFor(c, configured)
      .preparePreprovisionedEnrollment({
        nodeId: text(body.nodeId),
        provisioningRequestId: text(body.provisioningRequestId),
        instanceId: text(body.instanceId),
        region: region(body.region),
        expectedCapacity: {
          workloadClasses: workloadClasses(capacity.workloadClasses),
          totalMemoryMiB: integer(capacity.totalMemoryMiB),
          totalSharedCpu: integer(capacity.totalSharedCpu),
          totalWorkspaceGiB: integer(capacity.totalWorkspaceGiB),
        },
      });
    return c.json(result, 201);
  });

  app.get("/v1/staging/shared-hosting/services", async (c) => {
    const config = getConfig(c);
    if (
      config.XMCL_DEPLOYMENT_ENVIRONMENT !== "staging" ||
      !config.XMCL_STAGING_NODE_OPERATOR_TOKEN ||
      !await bearerMatches(
        c.req.header("authorization"),
        config.XMCL_STAGING_NODE_OPERATOR_TOKEN,
      )
    ) {
      throw new SharedNodeTransportError("unauthorized");
    }
    const scheduler = c.var.sharedHostingScheduler;
    if (!scheduler) throw new SharedNodeTransportError("unavailable");
    return c.json(await scheduler.listAllServices());
  });

  app.get("/v1/staging/shared-hosting/diagnostics", async (c) => {
    const config = getConfig(c);
    if (
      config.XMCL_DEPLOYMENT_ENVIRONMENT !== "staging" ||
      !config.XMCL_STAGING_NODE_OPERATOR_TOKEN ||
      !await bearerMatches(
        c.req.header("authorization"),
        config.XMCL_STAGING_NODE_OPERATOR_TOKEN,
      )
    ) {
      throw new SharedNodeTransportError("unauthorized");
    }
    const scheduler = c.var.sharedHostingScheduler;
    const transport = c.var.sharedNodeTransport;
    if (!scheduler || !transport) {
      throw new SharedNodeTransportError("unavailable");
    }
    const [services, commands, nodes] = await Promise.all([
      scheduler.reconciliationServices(),
      transport.reconciliationCommands(),
      transport.reconciliationNodes(),
    ]);
    const heartbeats = await Promise.all(nodes.map(async (node) => ({
      nodeId: node.nodeId,
      heartbeat: await transport.stagingNodeHeartbeat(node.nodeId),
    })));
    const workspaceManifests = (await Promise.all(services.map((item) =>
      transport.reconciliationWorkspaceManifest(
        item.serviceId,
        item.workspace.revision + 1,
      )
    ))).filter((item) =>
      item !== undefined
    );
    const runtimeAuthorizations = await Promise.all(
      services.map(async (item) => ({
        serviceId: item.serviceId,
        ...await transport.reconciliationRuntimeAuthorization(item),
      })),
    );
    const endpoints = await Promise.all(services.map(async (item) => ({
      serviceId: item.serviceId,
      endpoint: await transport.endpointForService(
        item.serviceId,
        item.assignmentId,
      ),
    })));
    return c.json({
      services,
      commands,
      nodes,
      heartbeats,
      workspaceManifests,
      runtimeAuthorizations,
      endpoints,
    });
  });

  app.get("/v1/staging/shared-hosting/services/:serviceId", async (c) => {
    const config = getConfig(c);
    if (
      config.XMCL_DEPLOYMENT_ENVIRONMENT !== "staging" ||
      !config.XMCL_STAGING_NODE_OPERATOR_TOKEN ||
      !await bearerMatches(
        c.req.header("authorization"),
        config.XMCL_STAGING_NODE_OPERATOR_TOKEN,
      )
    ) {
      throw new SharedNodeTransportError("unauthorized");
    }
    const scheduler = c.var.sharedHostingScheduler;
    if (!scheduler) throw new SharedNodeTransportError("unavailable");
    const service = await scheduler.findServiceById(c.req.param("serviceId"));
    if (!service) throw new SharedNodeTransportError("service_not_found");
    return c.json(service);
  });

  for (const operation of ["start", "stop"] as const) {
    app.post(
      `/v1/staging/shared-hosting/services/:serviceId/${operation}`,
      async (c) => {
        const config = getConfig(c);
        if (
          config.XMCL_DEPLOYMENT_ENVIRONMENT !== "staging" ||
          !config.XMCL_STAGING_NODE_OPERATOR_TOKEN ||
          !await bearerMatches(
            c.req.header("authorization"),
            config.XMCL_STAGING_NODE_OPERATOR_TOKEN,
          )
        ) {
          throw new SharedNodeTransportError("unauthorized");
        }
        const idempotencyKey = c.req.header("idempotency-key");
        if (!idempotencyKey) {
          throw new SharedNodeTransportError("invalid_request");
        }
        const scheduler = c.var.sharedHostingScheduler;
        if (!scheduler) throw new SharedNodeTransportError("unavailable");
        const serviceId = c.req.param("serviceId");
        const service = await scheduler.findServiceById(serviceId);
        if (!service) throw new SharedNodeTransportError("service_not_found");
        return c.json(
          await scheduler[operation](
            service.accountId,
            serviceId,
            idempotencyKey,
          ),
          202,
        );
      },
    );
  }

  app.post(
    "/v1/staging/shared-hosting/nodes/:nodeId/drain",
    async (c) => {
      const config = getConfig(c);
      if (
        config.XMCL_DEPLOYMENT_ENVIRONMENT !== "staging" ||
        !config.XMCL_STAGING_NODE_OPERATOR_TOKEN ||
        !await bearerMatches(
          c.req.header("authorization"),
          config.XMCL_STAGING_NODE_OPERATOR_TOKEN,
        )
      ) {
        throw new SharedNodeTransportError("unauthorized");
      }
      const scheduler = c.var.sharedHostingScheduler;
      if (!scheduler) throw new SharedNodeTransportError("unavailable");
      await scheduler.markNodeDraining(c.req.param("nodeId"));
      return c.json({ nodeId: c.req.param("nodeId"), status: "draining" });
    },
  );

  app.post(
    "/v1/staging/shared-hosting/nodes/:nodeId/ready",
    async (c) => {
      const config = getConfig(c);
      if (
        config.XMCL_DEPLOYMENT_ENVIRONMENT !== "staging" ||
        !config.XMCL_STAGING_NODE_OPERATOR_TOKEN ||
        !await bearerMatches(
          c.req.header("authorization"),
          config.XMCL_STAGING_NODE_OPERATOR_TOKEN,
        )
      ) {
        throw new SharedNodeTransportError("unauthorized");
      }
      const scheduler = c.var.sharedHostingScheduler;
      if (!scheduler) throw new SharedNodeTransportError("unavailable");
      await scheduler.markNodeReady(c.req.param("nodeId"));
      return c.json({ nodeId: c.req.param("nodeId"), status: "ready" });
    },
  );

  app.post(
    "/v1/staging/shared-hosting/services/:serviceId/reassign",
    async (c) => {
      const config = getConfig(c);
      if (
        config.XMCL_DEPLOYMENT_ENVIRONMENT !== "staging" ||
        !config.XMCL_STAGING_NODE_OPERATOR_TOKEN ||
        !await bearerMatches(
          c.req.header("authorization"),
          config.XMCL_STAGING_NODE_OPERATOR_TOKEN,
        )
      ) {
        throw new SharedNodeTransportError("unauthorized");
      }
      const parsed = await rawJson(c, 16 * 1024);
      const scheduler = c.var.sharedHostingScheduler;
      if (!scheduler) throw new SharedNodeTransportError("unavailable");
      return c.json(
        await scheduler.reassignUnstartedService(
          c.req.param("serviceId"),
          text(parsed.value.nodeId),
        ),
        202,
      );
    },
  );

  app.post("/v1/internal/shared-nodes/register", async (c) => {
    const service = serviceFor(c, configured);
    const parsed = await rawJson(c, maxWorkspaceGrantRequestBytes);
    const body = parsed.value;
    const authorization = c.req.header("authorization") ?? "";
    const match = /^SharedNode-Bootstrap (.+)$/.exec(authorization);
    if (!match) throw new SharedNodeTransportError("unauthorized");
    const result = await service.register(
      {
        nodeId: text(body.nodeId),
        instanceId: text(body.instanceId),
        region: region(body.region),
        totalMemoryMiB: integer(body.totalMemoryMiB),
        totalSharedCpu: integer(body.totalSharedCpu),
        totalWorkspaceGiB: integer(body.totalWorkspaceGiB),
      },
      request(c, {
        body: parsed.body,
        authorization: undefined,
        bootstrapCredential: match[1],
      }),
    );
    return c.json(result, 201);
  });

  app.post("/v1/internal/shared-nodes/:nodeId/heartbeat", async (c) => {
    const service = serviceFor(c, configured);
    const parsed = await rawJson(c, maxWorkspaceGrantRequestBytes);
    const result = await service.heartbeat(
      c.req.param("nodeId"),
      heartbeat(parsed.value),
      request(c, { body: parsed.body }),
    );
    return c.json(result);
  });

  app.post(
    "/v1/internal/shared-nodes/:nodeId/credentials:rotate",
    async (c) => {
      const service = serviceFor(c, configured);
      return c.json(
        await service.rotateCredential(c.req.param("nodeId"), request(c)),
      );
    },
  );

  app.post("/v1/internal/shared-nodes/:nodeId/commands:next", async (c) => {
    const service = serviceFor(c, configured);
    const result = await service.nextCommand(c.req.param("nodeId"), request(c));
    return c.json({
      contractVersion: SHARED_NODE_TRANSPORT_CONTRACT_VERSION,
      ...(result ?? { command: null }),
    });
  });

  app.post(
    "/v1/internal/shared-nodes/:nodeId/workspace-grants/restore",
    async (c) => {
      const service = serviceFor(c, configured);
      const parsed = await rawJson(c, maxWorkspaceGrantRequestBytes);
      return c.json(
        await service.workspaceRestoreGrant(
          c.req.param("nodeId"),
          workspaceGrant(parsed.value),
          request(c, { body: parsed.body }),
        ),
      );
    },
  );

  app.post(
    "/v1/internal/shared-nodes/:nodeId/workspace-grants/sync",
    async (c) => {
      const service = serviceFor(c, configured);
      const parsed = await rawJson(c, maxWorkspaceGrantRequestBytes);
      return c.json(
        await service.workspaceSyncGrant(
          c.req.param("nodeId"),
          workspaceGrant(parsed.value),
          request(c, { body: parsed.body }),
        ),
      );
    },
  );

  app.post(
    "/v1/internal/shared-nodes/:nodeId/workspace-grants/publish",
    async (c) => {
      const service = serviceFor(c, configured);
      const parsed = await rawJson(c, maxWorkspaceGrantRequestBytes);
      return c.json(
        await service.workspacePublishGrant(
          c.req.param("nodeId"),
          workspaceGrant(parsed.value),
          request(c, { body: parsed.body }),
        ),
      );
    },
  );

  app.post(
    "/v1/internal/shared-nodes/:nodeId/commands/:commandId/ack",
    async (c) => {
      const service = serviceFor(c, configured);
      const parsed = await rawJson(c);
      const body = parsed.value;
      const result = await service.acknowledge(
        c.req.param("nodeId"),
        c.req.param("commandId"),
        text(body.leaseToken),
        integer(body.leaseGeneration),
        request(c, { body: parsed.body }),
        commandResult(body),
      );
      return c.json(result);
    },
  );

  app.post(
    "/v1/internal/shared-nodes/:nodeId/commands/:commandId/lease-renew",
    async (c) => {
      const service = serviceFor(c, configured);
      const parsed = await rawJson(c);
      const body = parsed.value;
      const result = await service.renewLease(
        c.req.param("nodeId"),
        c.req.param("commandId"),
        text(body.leaseToken),
        integer(body.leaseGeneration),
        request(c, { body: parsed.body }),
      );
      return c.json(result);
    },
  );

  app.post(
    "/v1/internal/shared-nodes/:nodeId/assignments/:assignmentId/started",
    async (c) => {
      const service = serviceFor(c, configured);
      const parsed = await rawJson(c);
      const body = parsed.value;
      const result = await service.started(
        c.req.param("nodeId"),
        {
          serviceId: text(body.serviceId),
          assignmentId: c.req.param("assignmentId"),
          endpoint: endpoint(body.endpoint),
        },
        request(c, { body: parsed.body }),
      );
      return c.json(result, 202);
    },
  );

  app.post(
    "/v1/internal/shared-nodes/:nodeId/assignments/:assignmentId/stopped",
    async (c) => {
      const service = serviceFor(c, configured);
      const parsed = await rawJson(c);
      const body = parsed.value;
      let input;
      try {
        input = {
          serviceId: text(body.serviceId),
          assignmentId: c.req.param("assignmentId"),
          commandId: text(body.commandId),
          leaseToken: text(body.leaseToken),
          leaseGeneration: integer(body.leaseGeneration),
        };
      } catch (error) {
        console.warn({
          event: "shared_node.stopped.invalid_request",
          serviceIdType: typeof body.serviceId,
          serviceIdLength: stringLength(body.serviceId),
          commandIdType: typeof body.commandId,
          commandIdLength: stringLength(body.commandId),
          leaseTokenType: typeof body.leaseToken,
          leaseTokenLength: stringLength(body.leaseToken),
          leaseGenerationType: typeof body.leaseGeneration,
          leaseGenerationValid: Number.isSafeInteger(body.leaseGeneration) &&
            Number(body.leaseGeneration) > 0,
        });
        throw error;
      }
      let result;
      try {
        result = await service.stopped(
          c.req.param("nodeId"),
          input,
          request(c, { body: parsed.body }),
        );
      } catch (error) {
        console.warn({
          event: "shared_node.stopped.failed",
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorCode: error && typeof error === "object" && "code" in error
            ? String(error.code)
            : undefined,
        });
        throw error;
      }
      return c.json(result, 202);
    },
  );

  app.post(
    "/v1/internal/shared-nodes/:nodeId/assignments/:assignmentId/stopped-synced",
    async (c) => {
      const service = serviceFor(c, configured);
      const parsed = await rawJson(c);
      const body = parsed.value;
      const result = await service.stoppedAndSynced(
        c.req.param("nodeId"),
        {
          serviceId: text(body.serviceId),
          assignmentId: c.req.param("assignmentId"),
          commandId: text(body.commandId),
          leaseToken: text(body.leaseToken),
          leaseGeneration: integer(body.leaseGeneration),
          workspace: {
            revision: nonNegativeInteger(body.revision),
            sizeBytes: nonNegativeInteger(body.sizeBytes),
            ...(typeof body.sha256 === "string" ? { sha256: body.sha256 } : {}),
          },
        },
        request(c, { body: parsed.body }),
      );
      return c.json(result, 202);
    },
  );

  app.onError((error, c) => {
    if (error instanceof SharedNodeTransportError) {
      const status = error.code === "unauthorized" ||
          error.code === "invalid_signature" ||
          error.code === "workspace_grant_denied"
        ? 401
        : error.code === "stale_request" || error.code === "replay_detected" ||
            error.code === "node_conflict"
        ? 409
        : error.code === "invalid_request"
        ? 400
        : error.code === "lease_conflict" ||
            error.code === "lease_maximum_exceeded"
        ? 409
        : error.code === "unavailable"
        ? 503
        : 404;
      return c.json(
        {
          contractVersion: SHARED_NODE_TRANSPORT_CONTRACT_VERSION,
          error: error.code,
          ...(getConfig(c).XMCL_DEPLOYMENT_ENVIRONMENT === "staging" &&
              error.detail
            ? { detail: error.detail }
            : {}),
        },
        status,
      );
    }
    return c.json(
      {
        contractVersion: SHARED_NODE_TRANSPORT_CONTRACT_VERSION,
        error: "shared_node_transport_unavailable",
      },
      503,
    );
  });
  return app;
}

function serviceFor(
  c: { var: AppEnv["Variables"] },
  configured?: SharedNodeTransportService,
) {
  const service = configured ?? c.var.sharedNodeTransport;
  if (!service) throw new SharedNodeTransportError("unavailable");
  return service;
}

async function rawJson(
  c: { req: { raw: Request } },
  maximumBytes?: number,
) {
  const contentLength = c.req.raw.headers.get("content-length");
  if (
    maximumBytes !== undefined &&
    contentLength !== null &&
    (!/^[0-9]+$/.test(contentLength) ||
      Number(contentLength) > maximumBytes)
  ) {
    throw new SharedNodeTransportError("invalid_request");
  }
  const body = await c.req.raw.text();
  if (
    maximumBytes !== undefined &&
    new TextEncoder().encode(body).byteLength > maximumBytes
  ) {
    throw new SharedNodeTransportError("invalid_request");
  }
  try {
    const value = JSON.parse(body);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("invalid");
    }
    return { body, value: value as Record<string, unknown> };
  } catch {
    throw new SharedNodeTransportError("invalid_request");
  }
}

function request(
  c: {
    req: {
      method: string;
      path: string;
      header(name: string): string | undefined;
    };
  },
  extra: Record<string, unknown> = {},
): SharedNodeSignedRequest & Record<string, unknown> {
  return {
    method: c.req.method,
    path: c.req.path,
    body: "",
    timestamp: c.req.header("x-xmcl-timestamp"),
    nonce: c.req.header("x-xmcl-nonce"),
    bodyHash: c.req.header("x-xmcl-body-sha256"),
    signature: c.req.header("x-xmcl-signature"),
    authorization: c.req.header("authorization"),
    ...extra,
  };
}

function text(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 255) {
    throw new SharedNodeTransportError("invalid_request");
  }
  return value;
}

function stringLength(value: unknown) {
  return typeof value === "string" ? value.length : undefined;
}

function region(value: unknown) {
  if (!isSharedNodeRegion(value)) {
    throw new SharedNodeTransportError("invalid_request");
  }
  return value;
}

function integer(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new SharedNodeTransportError("invalid_request");
  }
  return value as number;
}

function commandResult(
  value: Record<string, unknown>,
): SharedNodeCommandResult | undefined {
  if (value.status === undefined) return undefined;
  if (
    value.status !== "started" &&
    value.status !== "failed" &&
    value.status !== "stopped-and-synced"
  ) {
    throw new SharedNodeTransportError("invalid_request");
  }
  const code = value.code;
  if (
    code !== undefined &&
    (typeof code !== "string" || !/^[a-z0-9_]{1,64}$/.test(code))
  ) {
    throw new SharedNodeTransportError("invalid_request");
  }
  const message = value.message;
  if (
    message !== undefined &&
    (typeof message !== "string" || message.length > 512 ||
      /[\u0000-\u001f\u007f]/.test(message))
  ) {
    throw new SharedNodeTransportError("invalid_request");
  }
  return {
    status: value.status,
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
  };
}

function nonNegativeInteger(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new SharedNodeTransportError("invalid_request");
  }
  return value as number;
}

function record(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SharedNodeTransportError("invalid_request");
  }
  return value as Record<string, unknown>;
}

function workloadClasses(value: unknown) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => item !== "standard" && item !== "large")
  ) {
    throw new SharedNodeTransportError("invalid_request");
  }
  return value as ("standard" | "large")[];
}

async function bearerMatches(
  authorization: string | undefined,
  expected: string,
) {
  const token = /^Bearer (.+)$/.exec(authorization ?? "")?.[1] ?? "";
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
  ]);
  let difference = token.length ^ expected.length;
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

function workspaceGrant(value: Record<string, unknown>) {
  return {
    contractVersion: value.contractVersion,
    commandId: text(value.commandId),
    assignmentId: text(value.assignmentId),
    leaseToken: text(value.leaseToken),
    leaseGeneration: integer(value.leaseGeneration),
    ...(typeof value.stage === "string"
      ? { stage: value.stage as "manifest" | "blobs" | "initial-world" }
      : {}),
    ...(Array.isArray(value.keys) ? { keys: value.keys.map(text) } : {}),
    ...(value.manifest && typeof value.manifest === "object" &&
        !Array.isArray(value.manifest)
      ? {
        manifest: value.manifest as Parameters<
          SharedNodeTransportService["workspaceSyncGrant"]
        >[1]["manifest"],
      }
      : {}),
    ...(typeof value.manifestSha256 === "string"
      ? { manifestSha256: value.manifestSha256 }
      : {}),
  } as Parameters<SharedNodeTransportService["workspaceSyncGrant"]>[1];
}

function heartbeat(value: Record<string, unknown>) {
  const capacity = value.capacity;
  if (!capacity || typeof capacity !== "object" || Array.isArray(capacity)) {
    throw new SharedNodeTransportError("invalid_request");
  }
  return {
    contractVersion: value.contractVersion,
    status: value.status,
    capacity: {
      freeWorkspaceGiB: (capacity as Record<string, unknown>).freeWorkspaceGiB,
      allocatableMemoryMiB: (capacity as Record<string, unknown>)
        .allocatableMemoryMiB,
      allocatableSharedCpu: (capacity as Record<string, unknown>)
        .allocatableSharedCpu,
      activeContainerCount: (capacity as Record<string, unknown>)
        .activeContainerCount,
    },
    services: Array.isArray(value.services)
      ? value.services.map((item) => {
        const service = item as Record<string, unknown>;
        return {
          serviceId: service.serviceId,
          assignmentId: service.assignmentId,
          cpuPercent: service.cpuPercent,
          memoryUsageMiB: service.memoryUsageMiB,
          memoryLimitMiB: service.memoryLimitMiB,
        };
      })
      : undefined,
    agentVersion: value.agentVersion,
    ingress: value.ingress,
  } as Parameters<SharedNodeTransportService["heartbeat"]>[1];
}

function endpoint(value: unknown): { host: string; port: number };
function endpoint(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SharedNodeTransportError("invalid_request");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.host !== "string" ||
    !Number.isSafeInteger(record.port)
  ) {
    throw new SharedNodeTransportError("invalid_request");
  }
  return { host: record.host, port: record.port as number };
}

export default createSharedNodeTransportRoutes();
