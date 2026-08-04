import type { Context } from "hono";
import { Hono } from "hono";
import { type AppConfig, getConfig } from "../config.ts";
import { AccountError } from "../lib/account.ts";
import { handleAccountError } from "../lib/accountHttp.ts";
import { getAccountRuntime } from "../lib/accountRuntime.ts";
import { OfflineJwtService } from "../lib/offlineJwt.ts";
import type { AccountRuntimeResolver } from "../middleware/xmclAuth.ts";
import { xmclAuth } from "../middleware/xmclAuth.ts";
import type { AppEnv } from "../types.ts";

interface LlmPoolEntry {
  endpoint: string;
  model: string;
  key: string;
}

type LlmPools = Record<string, LlmPoolEntry[]>;
type AppConfigResolver = (c: Context<AppEnv>) => AppConfig;

export function createLlmRoutes(
  resolve: AccountRuntimeResolver = getAccountRuntime,
  resolveConfig: AppConfigResolver = getConfig,
) {
  const app = new Hono<AppEnv>();
  app.onError(handleAccountError);

  app.get("/.well-known/jwks.json", (c) => {
    const service = new OfflineJwtService(resolveConfig(c));
    c.header("Cache-Control", "public, max-age=300");
    return c.json(service.jwks());
  });

  app.post(
    "/v1/auth/gateway-token",
    xmclAuth([], resolve),
    async (c) => {
      const principal = c.get("xmclPrincipal")!;
      const runtime = await resolve(c);
      const account = await runtime.accounts.requireActiveAccount(
        principal.accountId,
      );
      const token = await new OfflineJwtService(resolveConfig(c)).issue({
        accountId: principal.accountId,
        sessionId: principal.sessionId,
        scopes: principal.scopes,
        tier: validTier(account.tier) ? account.tier : "free",
      });
      return c.json(token);
    },
  );

  app.get("/llm-pool", async (c) => {
    const config = resolveConfig(c);
    const expected = config.LLM_POOL_SERVICE_SECRET;
    if (!expected) throw new Error("LLM_POOL_SERVICE_SECRET is not set");
    const header = serviceHeader(config.LLM_POOL_SERVICE_HEADER);
    const supplied = c.req.header(header);
    if (!supplied || !await secretsEqual(supplied, expected)) {
      throw new AccountError(401, "invalid_service_secret");
    }

    if (!config.LLM_POOL_CONFIG) {
      throw new Error("LLM_POOL_CONFIG is not set");
    }

    let pools: LlmPools;
    try {
      pools = JSON.parse(config.LLM_POOL_CONFIG) as LlmPools;
    } catch {
      throw new Error("LLM_POOL_CONFIG must be valid JSON");
    }
    validatePools(pools);
    c.header("Cache-Control", "no-store");
    return c.json(pools);
  });

  return app;
}

export default createLlmRoutes();

function serviceHeader(value: string | undefined) {
  const header = value?.trim().toLowerCase() || "x-service-secret";
  if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(header)) {
    throw new Error("LLM_POOL_SERVICE_HEADER is invalid");
  }
  return header;
}

function validTier(value: string | undefined): value is string {
  return value !== undefined && /^[a-z0-9][a-z0-9_-]{0,31}$/i.test(value);
}

function validatePools(value: LlmPools) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("LLM_POOL_CONFIG must be a tier-keyed object");
  }
  const tiers = Object.entries(value);
  if (tiers.length === 0) throw new Error("LLM_POOL_CONFIG has no tiers");
  for (const [tier, entries] of tiers) {
    if (!validTier(tier) || !Array.isArray(entries) || entries.length === 0) {
      throw new Error(`LLM_POOL_CONFIG tier '${tier}' is invalid`);
    }
    for (const entry of entries) {
      if (
        !entry || typeof entry !== "object" ||
        typeof entry.endpoint !== "string" ||
        typeof entry.model !== "string" || entry.model.length === 0 ||
        typeof entry.key !== "string" || entry.key.length === 0
      ) {
        throw new Error(`LLM_POOL_CONFIG tier '${tier}' has an invalid entry`);
      }
      let endpoint: URL;
      try {
        endpoint = new URL(entry.endpoint);
      } catch {
        throw new Error(`LLM_POOL_CONFIG tier '${tier}' has an invalid URL`);
      }
      if (endpoint.protocol !== "https:") {
        throw new Error(
          `LLM_POOL_CONFIG tier '${tier}' endpoint must use HTTPS`,
        );
      }
    }
  }
}

async function secretsEqual(left: string, right: string) {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)),
  ]);
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < a.length; index++) {
    difference |= a[index] ^ b[index];
  }
  return difference === 0;
}
