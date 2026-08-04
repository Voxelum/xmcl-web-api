import { Hono } from "hono";
import { AccountError } from "../lib/account.ts";
import { handleAccountError, jsonBody } from "../lib/accountHttp.ts";
import { getAccountRuntime } from "../lib/accountRuntime.ts";
import type { SharedHostingService } from "../lib/sharedHosting.ts";
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
) {
  const app = new Hono<AppEnv>();
  app.onError(handleAccountError);
  app.use("/v1/shared-hosting/*", xmclAuth(["account:read"], resolve));

  app.get(
    "/v1/shared-hosting/plans",
    (c) => c.json(serviceFor(c, sharedHosting).listPlans()),
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
    return c.json(
      await serviceFor(c, sharedHosting).subscribe({
        accountId: principal.accountId,
        planId: String(body.planId ?? ""),
        idempotencyKey: requireIdempotencyKey(c),
      }),
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
