import type { Context } from "hono";
import { Hono } from "hono";
import type { AppEnv } from "../types.ts";
import { AccountError } from "../lib/account.ts";
import { getAccountRuntime } from "../lib/accountRuntime.ts";
import { handleAccountError, jsonBody, requestId } from "../lib/accountHttp.ts";
import { isOAuthProvider, type OAuthProvider } from "../lib/oauth/types.ts";
import type { AccountRuntimeResolver } from "../middleware/xmclAuth.ts";
import { xmclAuth } from "../middleware/xmclAuth.ts";

function providerFrom(c: Context<AppEnv>): OAuthProvider {
  const value = c.req.param("provider");
  if (!isOAuthProvider(value)) {
    throw new AccountError(404, "provider_not_found");
  }
  return value;
}

function publicAccount(account: {
  accountId: string;
  status: string;
  createdAt: string;
  deletionEffectiveAt?: string;
}) {
  return {
    accountId: account.accountId,
    status: account.status,
    createdAt: account.createdAt,
    ...(account.deletionEffectiveAt
      ? { deletionEffectiveAt: account.deletionEffectiveAt }
      : {}),
  };
}

function publicIdentity(identity: {
  provider: OAuthProvider;
  displayName?: string;
  linkedBy: "launcher_bootstrap" | "launcher_link" | "web_link";
  linkedAt: string;
}) {
  return {
    provider: identity.provider,
    ...(identity.displayName ? { displayName: identity.displayName } : {}),
    linkedBy: identity.linkedBy,
    linkedAt: identity.linkedAt,
  };
}

function requireAccountWrite(scopes: string[]) {
  if (!scopes.includes("account:write")) {
    throw new AccountError(
      403,
      "insufficient_scope",
      "Required scope is missing",
    );
  }
}

export function createAccountRoutes(
  resolve: AccountRuntimeResolver = getAccountRuntime,
) {
  const app = new Hono<AppEnv>();
  app.onError(handleAccountError);
  app.use("/v1/account/*", xmclAuth(["account:read"], resolve));

  app.get("/v1/account", async (c) => {
    const principal = c.get("xmclPrincipal")!;
    const account = await (await resolve(c)).accounts.requireAccount(
      principal.accountId,
    );
    return c.json(publicAccount(account));
  });

  app.get("/v1/account/identities", async (c) => {
    const principal = c.get("xmclPrincipal")!;
    const account = await (await resolve(c)).accounts.requireAccount(
      principal.accountId,
    );
    return c.json(account.identities.map(publicIdentity));
  });

  app.post("/v1/account/identities/:provider/authorize", async (c) => {
    const principal = c.get("xmclPrincipal")!;
    requireAccountWrite(principal.scopes);
    const provider = providerFrom(c);
    const runtime = await resolve(c);
    const body = await jsonBody(c);
    const adapter = runtime.oauth[provider];
    const transaction = await runtime.accounts.createAuthorization({
      provider,
      intent: "link",
      accountId: principal.accountId,
      redirectUri: String(body.redirectUri ?? ""),
      state: String(body.state ?? ""),
      codeChallenge: String(body.codeChallenge ?? ""),
      allowedRedirectUris: adapter.declaration.redirectUris,
    });
    return c.json({
      transactionId: transaction.transactionId,
      authorizationUrl: adapter.authorizationUrl(transaction),
      expiresAt: transaction.expiresAt,
    });
  });

  app.post("/v1/account/identities/:provider/complete", async (c) => {
    const principal = c.get("xmclPrincipal")!;
    requireAccountWrite(principal.scopes);
    const provider = providerFrom(c);
    const runtime = await resolve(c);
    const body = await jsonBody(c);
    const transaction = await runtime.accounts.consumeAuthorization({
      transactionId: String(body.transactionId ?? ""),
      provider,
      state: String(body.state ?? ""),
      codeVerifier: String(body.codeVerifier ?? ""),
    });
    if (
      transaction.intent !== "link" ||
      transaction.accountId !== principal.accountId
    ) throw new AccountError(409, "oauth_intent_mismatch");
    const identity = await runtime.oauth[provider].exchange({
      code: String(body.code ?? ""),
      codeVerifier: String(body.codeVerifier ?? ""),
      redirectUri: transaction.redirectUri,
    });
    const result = await runtime.accounts.bindIdentity({
      identity,
      currentAccountId: principal.accountId,
      linkedBy: "web_link",
    });
    return c.json({
      identity: publicIdentity(
        result.account.identities.find((item) => item.provider === provider)!,
      ),
      bindingDisposition: result.bindingDisposition,
    });
  });

  app.delete("/v1/account/identities/:provider", async (c) => {
    const principal = c.get("xmclPrincipal")!;
    requireAccountWrite(principal.scopes);
    await (await resolve(c)).accounts.unlinkIdentity(
      principal.accountId,
      providerFrom(c),
      requestId(c),
    );
    return c.body(null, 204);
  });

  app.post("/v1/account/merge/prepare", async (c) => {
    const principal = c.get("xmclPrincipal")!;
    requireAccountWrite(principal.scopes);
    const runtime = await resolve(c);
    const body = await jsonBody(c);
    const providerValue = String(body.provider ?? "");
    if (!isOAuthProvider(providerValue)) {
      throw new AccountError(422, "invalid_provider");
    }
    const completedAt = String(body.completedAt ?? "");
    const timestamp = Date.parse(completedAt);
    const now = Date.now();
    if (
      !Number.isFinite(timestamp) || timestamp < now - 5 * 60_000 ||
      timestamp > now + 60_000
    ) {
      throw new AccountError(422, "invalid_oauth_request");
    }
    const identity = await runtime.oauth[providerValue]
      .verifyLauncherCredential({
        accessToken: String(body.credential ?? ""),
        completedAt,
      });
    return c.json(
      await runtime.merges.prepare({
        currentAccountId: principal.accountId,
        verifiedTargetIdentity: identity,
        requestId: requestId(c),
      }),
    );
  });

  app.post("/v1/account/merge/confirm", async (c) => {
    const principal = c.get("xmclPrincipal")!;
    requireAccountWrite(principal.scopes);
    const body = await jsonBody(c);
    const result = await (await resolve(c)).merges.confirm({
      currentAccountId: principal.accountId,
      mergeId: String(body.mergeId ?? ""),
      confirmed: body.confirmed === true,
      idempotencyKey: c.req.header("idempotency-key") ?? "",
      requestId: requestId(c),
    });
    return c.json(result, 202);
  });

  app.post("/v1/account/deletion", async (c) => {
    const principal = c.get("xmclPrincipal")!;
    requireAccountWrite(principal.scopes);
    const result = await (await resolve(c)).accounts.requestDeletion(
      principal.accountId,
      c.req.header("idempotency-key") ?? "",
      requestId(c),
    );
    return c.json(result, 202);
  });

  app.post("/v1/account/deletion/cancel", async (c) => {
    const principal = c.get("xmclPrincipal")!;
    requireAccountWrite(principal.scopes);
    await (await resolve(c)).accounts.cancelDeletion(
      principal.accountId,
      requestId(c),
    );
    return c.body(null, 204);
  });

  return app;
}

export default createAccountRoutes();
