import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../types.ts";
import { AccountError } from "../account.ts";
import {
  type AccountRuntime,
  getAccountRuntime,
  verifyAccessToken,
} from "../accountRuntime.ts";
import { verifyDpopProof } from "../dpop.ts";
import {
  requiresSharedDpopReplay,
  resolveDpopReplayStore,
} from "../dpopReplayRuntime.ts";

export type AccountRuntimeResolver = (
  c: Context<AppEnv>,
) => Promise<AccountRuntime>;

export async function authenticateXmclRequest(
  c: Context<AppEnv>,
  runtime: AccountRuntimeResolver = getAccountRuntime,
  optional = false,
) {
  const authorization = c.req.header("authorization");
  if (!authorization) {
    if (optional) return undefined;
    throw new AccountError(401, "authentication_required");
  }
  const separator = authorization.indexOf(" ");
  if (separator <= 0 || separator === authorization.length - 1) {
    throw new AccountError(401, "invalid_access_token");
  }
  const scheme = authorization.slice(0, separator);
  const accessToken = authorization.slice(separator + 1);
  if (scheme !== "Bearer" && scheme !== "DPoP") {
    throw new AccountError(401, "invalid_access_token");
  }

  const overridden = c.get("accountRuntime");
  const principal = overridden
    ? await overridden.sessions.verify(accessToken)
    : runtime === getAccountRuntime
    ? await verifyAccessToken(c, accessToken)
    : await (await runtime(c)).sessions.verify(accessToken);

  if (principal.dpopJkt) {
    if (scheme !== "DPoP") {
      throw new AccountError(401, "invalid_dpop_proof");
    }
    const proof = c.req.header("dpop");
    if (!proof) throw new AccountError(401, "invalid_dpop_proof");
    await verifyDpopProof({
      proof,
      method: c.req.method,
      url: c.req.url,
      accessToken,
      expectedJkt: principal.dpopJkt,
      replayStore: requiresSharedDpopReplay(c.req.method, c.req.url)
        ? await resolveDpopReplayStore(c)
        : undefined,
    });
  } else if (scheme !== "Bearer") {
    throw new AccountError(401, "invalid_dpop_proof");
  }
  return principal;
}

export function xmclAuth(
  requiredScopes: string[] = [],
  runtime: AccountRuntimeResolver = getAccountRuntime,
) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const principal = (await authenticateXmclRequest(c, runtime))!;
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
