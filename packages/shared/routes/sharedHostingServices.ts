import { Hono } from "hono";
import { AccountError } from "../lib/account.ts";
import { handleAccountError, jsonBody } from "../lib/accountHttp.ts";
import { getAccountRuntime } from "../lib/accountRuntime.ts";
import type {
  SharedHostingScheduler,
  SharedHostingServiceRecord,
} from "../lib/sharedHostingScheduler.ts";
import type { AccountRuntimeResolver } from "../middleware/xmclAuth.ts";
import { xmclAuth } from "../middleware/xmclAuth.ts";
import type { AppEnv } from "../types.ts";
import { requireIdempotencyKey } from "./billing.ts";

function requireAccountWrite(scopes: string[]) {
  if (!scopes.includes("account:write")) {
    throw new AccountError(403, "insufficient_scope");
  }
}

function publicService(value: SharedHostingServiceRecord) {
  return {
    serviceId: value.serviceId,
    subscriptionId: value.subscriptionId,
    planId: value.planId,
    status: value.status,
    workspace: {
      revision: value.workspace.revision,
      sizeBytes: value.workspace.sizeBytes,
      syncedAt: value.workspace.syncedAt,
      storageOverageSince: value.storageOverageSince,
      storageGraceEndsAt: value.storageGraceEndsAt,
    },
    statusReason: value.statusReason,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function createSharedHostingServiceRoutes(
  scheduler?: SharedHostingScheduler,
  resolve: AccountRuntimeResolver = getAccountRuntime,
) {
  const app = new Hono<AppEnv>();
  app.onError(handleAccountError);
  app.use("/v1/shared-hosting/services/*", xmclAuth(["account:read"], resolve));

  app.get("/v1/shared-hosting/services", async (c) =>
    c.json(
      (await schedulerFor(c, scheduler).listServices(
        c.get("xmclPrincipal")!.accountId,
      )).map(publicService),
    ));
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
