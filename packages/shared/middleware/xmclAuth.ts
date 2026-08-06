import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../types.ts";
import { AccountError } from "../lib/account.ts";
import {
  type AccountRuntime,
  getAccountRuntime,
} from "../lib/accountRuntime.ts";

export type AccountRuntimeResolver = (
  c: Context<AppEnv>,
) => Promise<AccountRuntime>;

export function xmclAuth(
  requiredScopes: string[] = [],
  runtime: AccountRuntimeResolver = getAccountRuntime,
) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const authorization = c.req.header("authorization");
    if (!authorization?.startsWith("Bearer ")) {
      throw new AccountError(401, "authentication_required");
    }
    const principal = await (await runtime(c)).sessions.verify(
      authorization.slice("Bearer ".length),
    );
    if (requiredScopes.some((scope) => !principal.scopes.includes(scope))) {
      throw new AccountError(
        403,
        "insufficient_scope",
        "Required scope is missing",
        {
          requiredScopes,
        },
      );
    }
    c.set("xmclPrincipal", principal);
    await next();
  });
}
