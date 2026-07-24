import type { Context } from "hono";
import { Hono } from "hono";
import type { AppEnv } from "../types.ts";
import { AccountError } from "../lib/account.ts";
import {
  type AccountRuntime,
  getAccountRuntime,
} from "../lib/accountRuntime.ts";
import { handleAccountError, jsonBody } from "../lib/accountHttp.ts";
import { createOAuthRedirectPolicy } from "../lib/oauth/redirectPolicy.ts";
import { isOAuthProvider, type OAuthProvider } from "../lib/oauth/types.ts";
import type { AccountRuntimeResolver } from "../middleware/xmclAuth.ts";
import { xmclAuth } from "../middleware/xmclAuth.ts";

function publicAccount(account: {
  accountId: string;
  status: string;
  createdAt: string;
}) {
  return {
    accountId: account.accountId,
    status: account.status,
    createdAt: account.createdAt,
  };
}

async function optionalAccountId(c: Context<AppEnv>, runtime: AccountRuntime) {
  const authorization = c.req.header("authorization");
  if (!authorization) return undefined;
  if (!authorization.startsWith("Bearer ")) {
    throw new AccountError(401, "invalid_access_token");
  }
  try {
    return (await runtime.sessions.verify(authorization.slice(7))).accountId;
  } catch (error) {
    // Launcher-exchange can restore an account from a newly verified provider
    // credential. An expired optional XMCL bearer must not block that recovery.
    if (error instanceof AccountError && error.code === "access_token_expired") {
      return undefined;
    }
    throw error;
  }
}

function providerFrom(c: Context<AppEnv>): OAuthProvider {
  const value = c.req.param("provider");
  if (!isOAuthProvider(value)) {
    throw new AccountError(404, "provider_not_found");
  }
  return value;
}

export function createSessionRoutes(
  resolve: AccountRuntimeResolver = getAccountRuntime,
) {
  const app = new Hono<AppEnv>();
  app.onError(handleAccountError);

  app.get("/v1/auth/:provider/authorize", async (c) => {
    const provider = providerFrom(c);
    const runtime = await resolve(c);
    const adapter = runtime.oauth[provider];
    if (!adapter.declaration.clientId) {
      throw new AccountError(503, "provider_not_configured");
    }
    const transaction = await runtime.accounts.createAuthorization({
      provider,
      intent: "sign_in",
      redirectUri: c.req.query("redirectUri") ?? "",
      state: c.req.query("state") ?? "",
      codeChallenge: c.req.query("codeChallenge") ?? "",
      redirectPolicy: createOAuthRedirectPolicy(
        adapter.declaration.redirectUris,
      ),
    });
    return c.json({
      transactionId: transaction.transactionId,
      authorizationUrl: adapter.authorizationUrl(transaction),
      expiresAt: transaction.expiresAt,
    });
  });

  app.post("/v1/auth/:provider/exchange", async (c) => {
    const provider = providerFrom(c);
    const runtime = await resolve(c);
    const body = await jsonBody(c);
    const transaction = await runtime.accounts.consumeAuthorization({
      transactionId: String(body.transactionId ?? ""),
      provider,
      state: String(body.state ?? ""),
      codeVerifier: String(body.codeVerifier ?? ""),
    });
    if (transaction.intent !== "sign_in") {
      throw new AccountError(409, "oauth_intent_mismatch");
    }
    const identity = await runtime.oauth[provider].exchange({
      code: String(body.code ?? ""),
      codeVerifier: String(body.codeVerifier ?? ""),
      redirectUri: transaction.redirectUri,
    });
    const binding = await runtime.accounts.bindIdentity({
      identity,
      linkedBy: "web_link",
    });
    const session = await runtime.sessions.issue(binding.account.accountId);
    return c.json({
      account: publicAccount(binding.account),
      session,
      bindingDisposition: binding.bindingDisposition,
    });
  });

  app.post("/v1/auth/:provider/launcher-exchange", async (c) => {
    const provider = providerFrom(c);
    const runtime = await resolve(c);
    const body = await jsonBody(c);
    const completedAt = String(body.completedAt ?? "");
    await runtime.accounts.consumeLauncherTransaction({
      transactionId: String(body.loginTransactionId ?? ""),
      provider,
      completedAt,
    });
    const identity = await runtime.oauth[provider].verifyLauncherCredential({
      accessToken: String(body.credential ?? ""),
      completedAt,
    });
    const currentAccountId = await optionalAccountId(c, runtime);
    const binding = await runtime.accounts.bindIdentity({
      identity,
      currentAccountId,
      linkedBy: currentAccountId ? "launcher_link" : "launcher_bootstrap",
    });
    const session = await runtime.sessions.issue(binding.account.accountId);
    return c.json({
      account: publicAccount(binding.account),
      session,
      bindingDisposition: binding.bindingDisposition,
    });
  });

  app.post("/v1/sessions/refresh", async (c) => {
    const body = await jsonBody(c);
    const session = await (await resolve(c)).sessions.refresh(
      String(body.sessionId ?? ""),
      String(body.refreshToken ?? ""),
    );
    return c.json({ session });
  });

  app.post(
    "/v1/sessions/revoke",
    xmclAuth(["session:manage"], resolve),
    async (c) => {
      const body = await jsonBody(c);
      const principal = c.get("xmclPrincipal")!;
      const target = body.all === true
        ? "all"
        : String(body.sessionId ?? principal.sessionId);
      await (await resolve(c)).sessions.revoke(principal.accountId, target);
      return c.body(null, 204);
    },
  );

  return app;
}

export default createSessionRoutes();
