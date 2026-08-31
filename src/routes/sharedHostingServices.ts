import { Hono } from "hono";
import { AccountError } from "../account.ts";
import { handleAccountError, jsonBody } from "../accountHttp.ts";
import { getAccountRuntime } from "../accountRuntime.ts";
import type {
  SharedHostingScheduler,
  SharedHostingServiceRecord,
} from "../sharedHostingScheduler.ts";
import type { SharedNodeTransportService } from "../sharedNodeTransport.ts";
import type { AccountRuntimeResolver } from "../middleware/xmclAuth.ts";
import { xmclAuth } from "../middleware/xmclAuth.ts";
import type { AppEnv } from "../types.ts";
import { requireIdempotencyKey } from "./billing.ts";

function requireAccountWrite(scopes: string[]) {
  if (!scopes.includes("account:write")) {
    throw new AccountError(403, "insufficient_scope");
  }
}

export function publicService(
  value: SharedHostingServiceRecord,
  metrics?: {
    cpuPercent: number;
    memoryUsageMiB: number;
    memoryLimitMiB: number;
    observedAt: string;
  },
) {
  return {
    serviceId: value.serviceId,
    subscriptionId: value.subscriptionId,
    planId: value.planId,
    regionId: value.regionId,
    status: value.status,
    workspace: {
      revision: value.workspace.revision,
      sizeBytes: value.workspace.sizeBytes,
      syncedAt: value.workspace.syncedAt ?? undefined,
      storageOverageSince: value.storageOverageSince ?? undefined,
      storageGraceEndsAt: value.storageGraceEndsAt ?? undefined,
    },
    statusReason: value.statusReason ?? undefined,
    metrics,
    retentionStartedAt: value.retentionStartedAt ?? undefined,
    retentionEndsAt: value.retentionEndsAt ?? undefined,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function createSharedHostingServiceRoutes(
  scheduler?: SharedHostingScheduler,
  resolve: AccountRuntimeResolver = getAccountRuntime,
  transport?: SharedNodeTransportService,
) {
  const app = new Hono<AppEnv>();
  app.onError(handleAccountError);
  app.use("/v1/shared-hosting/services/*", xmclAuth(["account:read"], resolve));

  app.get("/v1/shared-hosting/services", async (c) => {
    const accountId = c.get("xmclPrincipal")!.accountId;
    const services = await schedulerFor(c, scheduler).listServices(accountId);
    const activeTransport = transport ?? c.var.sharedNodeTransport;
    return c.json(
      await Promise.all(services.map(async (service) =>
        publicService(
          service,
          activeTransport
            ? await activeTransport.sharedServiceMetrics(
              accountId,
              service.serviceId,
            )
            : undefined,
        )
      )),
    );
  });
  app.get("/v1/shared-hosting/services/:serviceId/export", async (c) => {
    const principal = c.get("xmclPrincipal")!;
    return c.json(
      await transportFor(c, transport).retainedWorkspaceExport(
        principal.accountId,
        c.req.param("serviceId"),
      ),
    );
  });
  app.post("/v1/shared-hosting/services", async (c) => {
    const principal = c.get("xmclPrincipal")!;
    requireAccountWrite(principal.scopes);
    const body = await jsonBody(c);
    const result = await schedulerFor(c, scheduler).createService({
      accountId: principal.accountId,
      subscriptionId: String(body.subscriptionId ?? ""),
      idempotencyKey: requireIdempotencyKey(c),
    });
    return c.json(publicService(result), 201);
  });
  for (const operation of ["start", "stop"] as const) {
    app.post(
      `/v1/shared-hosting/services/:serviceId/${operation}`,
      async (c) => {
        const principal = c.get("xmclPrincipal")!;
        requireAccountWrite(principal.scopes);
        const result = await schedulerFor(c, scheduler)[operation](
          principal.accountId,
          c.req.param("serviceId"),
          requireIdempotencyKey(c),
        );
        return c.json(publicService(result), 202);
      },
    );
  }

  function transportFor(
    c: { var: AppEnv["Variables"] },
    injected?: SharedNodeTransportService,
  ) {
    const transport = injected ?? c.var.sharedNodeTransport;
    if (!transport) {
      throw new AccountError(503, "shared_workspace_export_unavailable");
    }
    return transport;
  }
  return app;
}

function schedulerFor(
  c: { var: AppEnv["Variables"] },
  injected?: SharedHostingScheduler,
) {
  const scheduler = injected ?? c.var.sharedHostingScheduler;
  if (!scheduler) {
    throw new AccountError(503, "shared_hosting_scheduler_unavailable");
  }
  return scheduler;
}

export default createSharedHostingServiceRoutes();
