import { Hono } from "hono";
import { AccountError } from "../account.ts";
import { handleAccountError } from "../accountHttp.ts";
import { getAccountRuntime } from "../accountRuntime.ts";
import { getBillingRuntime } from "../billingRuntime.ts";
import type { AccountRuntimeResolver } from "../middleware/xmclAuth.ts";
import { xmclAuth } from "../middleware/xmclAuth.ts";
import type { AppEnv } from "../types.ts";
import type { XmclPlusService } from "../xmclPlus.ts";
import { requireIdempotencyKey } from "./billing.ts";

function requireAccountWrite(scopes: string[]) {
  if (!scopes.includes("account:write")) {
    throw new AccountError(403, "insufficient_scope");
  }
}

export function createXmclPlusRoutes(
  plus?: XmclPlusService,
  resolve: AccountRuntimeResolver = getAccountRuntime,
) {
  const app = new Hono<AppEnv>();
  app.onError(handleAccountError);
  app.use("/v1/xmcl-plus/*", xmclAuth(["account:read"], resolve));
  app.get("/v1/xmcl-plus/offer", async (c) =>
    c.json((await serviceFor(c, plus)).offer()));
  app.get("/v1/xmcl-plus/status", async (c) =>
    c.json(
      await (await serviceFor(c, plus)).status(
        c.get("xmclPrincipal")!.accountId,
      ),
    ));
  app.get("/v1/xmcl-plus/trial", async (c) =>
    c.json(
      await (await serviceFor(c, plus)).trialStatus(
        c.get("xmclPrincipal")!.accountId,
      ),
    ));
  app.get("/v1/xmcl-plus/allowances", async (c) =>
    c.json(
      await (await serviceFor(c, plus)).allowances(
        c.get("xmclPrincipal")!.accountId,
      ),
    ));
  app.post("/v1/xmcl-plus/trial", async (c) => {
    const principal = c.get("xmclPrincipal")!;
    requireAccountWrite(principal.scopes);
    return c.json(
      await (await serviceFor(c, plus)).claimTrial({
        accountId: principal.accountId,
        idempotencyKey: requireIdempotencyKey(c),
      }),
      201,
    );
  });
  app.post("/v1/xmcl-plus/subscribe", async (c) => {
    const principal = c.get("xmclPrincipal")!;
    requireAccountWrite(principal.scopes);
    return c.json(
      await (await serviceFor(c, plus)).subscribe({
        accountId: principal.accountId,
        idempotencyKey: requireIdempotencyKey(c),
      }),
      201,
    );
  });
  app.post("/v1/xmcl-plus/cancel", async (c) => {
    const principal = c.get("xmclPrincipal")!;
    requireAccountWrite(principal.scopes);
    return c.json(
      await (await serviceFor(c, plus)).cancel(
        principal.accountId,
        requireIdempotencyKey(c),
      ),
    );
  });
  return app;
}

async function serviceFor(
  c: Parameters<typeof getBillingRuntime>[0],
  injected?: XmclPlusService,
) {
  const service = injected ?? c.var.xmclPlusService;
  if (service) return service;
  try {
    return (await getBillingRuntime(c)).plus;
  } catch (error) {
    if (error instanceof AccountError) throw error;
    throw new AccountError(503, "xmcl_plus_unavailable");
  }
}

export default createXmclPlusRoutes();
