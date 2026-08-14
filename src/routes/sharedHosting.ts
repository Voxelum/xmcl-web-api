import { Hono } from "hono";
import { AccountError } from "../account.ts";
import { handleAccountError, jsonBody } from "../accountHttp.ts";
import { getAccountRuntime } from "../accountRuntime.ts";
import type { SharedHostingService } from "../sharedHosting.ts";
import type { SharedHostingScheduler } from "../sharedHostingScheduler.ts";
import type { AccountRuntimeResolver } from "../middleware/xmclAuth.ts";
import { xmclAuth } from "../middleware/xmclAuth.ts";
import type { AppEnv } from "../types.ts";
import { requireIdempotencyKey } from "./billing.ts";

function requireAccountWrite(scopes: string[]) {
  if (!scopes.includes("account:write")) {
    throw new AccountError(403, "insufficient_scope");
  }
}

export function createSharedHostingRoutes(
  sharedHosting?: SharedHostingService,
  resolve: AccountRuntimeResolver = getAccountRuntime,
  scheduler?: SharedHostingScheduler,
) {
  const app = new Hono<AppEnv>();
  app.onError(handleAccountError);
  const authenticate = xmclAuth(["account:read"], resolve);
  app.use("/v1/shared-hosting/plans", authenticate);
  app.use("/v1/shared-hosting/regions", authenticate);
  app.use("/v1/shared-hosting/subscriptions", authenticate);
  app.use("/v1/shared-hosting/subscriptions/*", authenticate);

  app.get(
    "/v1/shared-hosting/plans",
    (c) => c.json(serviceFor(c, sharedHosting).listPlans()),
  );
  app.get(
    "/v1/shared-hosting/regions",
    (c) => c.json(serviceFor(c, sharedHosting).listRegions()),
  );
  app.get("/v1/shared-hosting/subscriptions", async (c) =>
    c.json(
      await serviceFor(c, sharedHosting).subscriptions(
        c.get("xmclPrincipal")!.accountId,
      ),
    ));
  app.post("/v1/shared-hosting/subscriptions", async (c) => {
    const principal = c.get("xmclPrincipal")!;
    requireAccountWrite(principal.scopes);
    const body = await jsonBody(c);
    const idempotencyKey = requireIdempotencyKey(c);
    const subscription = await serviceFor(c, sharedHosting).subscribe({
      accountId: principal.accountId,
      planId: String(body.planId ?? ""),
      regionId: String(body.regionId ?? ""),
      idempotencyKey,
    });
    const activeScheduler = scheduler ?? c.var.sharedHostingScheduler;
    if (activeScheduler) {
      await activeScheduler.createService({
        accountId: principal.accountId,
        subscriptionId: subscription.subscriptionId,
        idempotencyKey: `subscription:${idempotencyKey}`,
      });
    }
    return c.json(
      subscription,
      201,
    );
  });
  app.post(
    "/v1/shared-hosting/subscriptions/:subscriptionId/cancel",
    async (c) => {
      const principal = c.get("xmclPrincipal")!;
      requireAccountWrite(principal.scopes);
      return c.json(
        await serviceFor(c, sharedHosting).cancel(
          principal.accountId,
          c.req.param("subscriptionId"),
          requireIdempotencyKey(c),
        ),
      );
    },
  );
  return app;
}

function serviceFor(
  c: { var: AppEnv["Variables"] },
  injected?: SharedHostingService,
) {
  const service = injected ?? c.var.sharedHostingService;
  if (!service) throw new AccountError(503, "shared_hosting_unavailable");
  return service;
}

export default createSharedHostingRoutes();
