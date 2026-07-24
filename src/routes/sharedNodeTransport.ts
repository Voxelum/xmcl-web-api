import { Hono } from "hono";
import type { AppEnv } from "../types.ts";
import {
  type SharedNodeSignedRequest,
  SHARED_NODE_TRANSPORT_CONTRACT_VERSION,
  SharedNodeTransportError,
  type SharedNodeTransportService,
} from "../lib/sharedNodeTransport.ts";
import { isSharedNodeRegion } from "../lib/sharedHostingScheduler.ts";

const maxWorkspaceGrantRequestBytes = 1 << 20;

export function createSharedNodeTransportRoutes(
  configured?: SharedNodeTransportService,
) {
  const app = new Hono<AppEnv>();

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
        { contractVersion: SHARED_NODE_TRANSPORT_CONTRACT_VERSION, error: error.code },
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

function nonNegativeInteger(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new SharedNodeTransportError("invalid_request");
  }
  return value as number;
}

function workspaceGrant(value: Record<string, unknown>) {
  return {
    contractVersion: value.contractVersion,
    commandId: text(value.commandId),
    assignmentId: text(value.assignmentId),
    leaseToken: text(value.leaseToken),
    leaseGeneration: integer(value.leaseGeneration),
    ...(typeof value.stage === "string"
      ? { stage: value.stage as "manifest" | "blobs" }
      : {}),
    ...(Array.isArray(value.keys)
      ? { keys: value.keys.map(text) }
      : {}),
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
