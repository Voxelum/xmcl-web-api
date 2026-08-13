import type { Context } from "hono";
import { Hono } from "hono";
import { handleAccountError } from "../accountHttp.ts";
import { getAccountRuntime } from "../accountRuntime.ts";
import { type AppConfig, getConfig } from "../config.ts";
import { BillingEntitlementReader } from "../entitlements.ts";
import { MongoBillingStore } from "../ledger.ts";
import { TurnCredentialMeter } from "../turnMetering.ts";
import {
  type AccountRuntimeResolver,
  xmclAuth,
} from "../middleware/xmclAuth.ts";
import type { AppEnv } from "../types.ts";

const CREDENTIAL_TTL_SECONDS = 24 * 60 * 60;
const BUILTIN_TURNS = [
  { ip: "20.239.69.131", realm: "hk" },
  { ip: "20.199.15.21", realm: "fr" },
  { ip: "20.215.243.212", realm: "po" },
] as const;
const STUNS = [
  "stun.miwifi.com:3478",
  "stun.l.google.com:19302",
  "stun2.l.google.com:19302",
  "stun3.l.google.com:19302",
  "stun4.l.google.com:19302",
  "stun.voipbuster.com:3478",
  "stun.voipstunt.com:3478",
  "stun.internetcalls.com:3478",
  "stun.voip.aebc.com:3478",
  "stun.qq.com:3478",
] as const;

interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

interface RtcRouteOptions {
  resolveAccountRuntime?: AccountRuntimeResolver;
  resolveTurnEntitlement?: (
    c: Context<AppEnv>,
    accountId: string,
  ) => Promise<boolean>;
  fetch?: typeof fetch;
  resolveTurnMeter?: (
    c: Context<AppEnv>,
  ) => Promise<Pick<TurnCredentialMeter, "authorize" | "release">>;
  resolveConfig?: (c: Context<AppEnv>) => Pick<
    AppConfig,
    | "RTC_SECRET"
    | "TURNS"
    | "CLOUDFLARE_API_TOKEN"
    | "CLOUDFLARE_APP_ID"
    | "CLOUDFLARE_ACCOUNT_ID"
    | "CLOUDFLARE_ANALYTICS_API_TOKEN"
  >;
}

async function hmacSha1Base64(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

function parseTurns(turns: string | undefined) {
  if (!turns) return [];
  return turns.split(",").flatMap((entry) => {
    const separator = entry.indexOf(":");
    if (separator <= 0 || separator === entry.length - 1) {
      console.error({ event: "rtc.turns_configuration_error" });
      return [];
    }
    return [{
      realm: entry.slice(0, separator).trim(),
      ip: entry.slice(separator + 1).trim(),
    }];
  }).filter((turn) => turn.realm && turn.ip);
}

async function getBuiltinTurnCredentials(
  accountId: string,
  secret: string,
  configuredTurns: ReturnType<typeof parseTurns>,
) {
  const username = `${
    Math.floor(Date.now() / 1000) + CREDENTIAL_TTL_SECONDS
  }:${accountId}`;
  const password = await hmacSha1Base64(secret, username);
  const turns = [...BUILTIN_TURNS, ...configuredTurns];
  const uris = turns.map((turn) => `turn:${turn.ip}`);
  return {
    username,
    password,
    ttl: CREDENTIAL_TTL_SECONDS,
    uris,
    meta: Object.fromEntries(turns.map((turn) => [turn.ip, turn.realm])),
    servers: uris.map((urls) => ({
      urls,
      username,
      credential: password,
    })),
  };
}

async function getCloudflareTurnServers(
  keyId: string,
  apiToken: string,
  customIdentifier: string,
  fetcher: typeof fetch,
): Promise<IceServer[]> {
  const response = await fetcher(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${
      encodeURIComponent(keyId)
    }/credentials/generate`,
    {
      method: "POST",
      headers: {
        Authorization: ["Bear", "er ", apiToken].join(""),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ttl: CREDENTIAL_TTL_SECONDS,
        customIdentifier,
      }),
    },
  );
  if (!response.ok) {
    console.error({
      event: "rtc.cloudflare_api_rejected",
      providerStatus: response.status,
    });
    return [];
  }
  const body = await response.json() as { iceServers?: unknown };
  if (!Array.isArray(body.iceServers)) {
    console.error({ event: "rtc.cloudflare_invalid_response" });
    return [];
  }
  return body.iceServers.flatMap((value): IceServer[] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const server = value as Record<string, unknown>;
    const urls = typeof server.urls === "string" ? [server.urls] : server.urls;
    if (
      !Array.isArray(urls) ||
      !urls.every((url) => typeof url === "string") ||
      typeof server.username !== "string" ||
      !server.username ||
      typeof server.credential !== "string" ||
      !server.credential
    ) return [];
    const turnUrls = urls.filter((url) =>
      url.startsWith("turn:") || url.startsWith("turns:")
    );
    return turnUrls.length === 0 ? [] : [{
      urls: turnUrls,
      username: server.username,
      credential: server.credential,
    }];
  });
}

export function createRtcRoutes(options: RtcRouteOptions = {}) {
  const app = new Hono<AppEnv>();
  const resolveAccountRuntime = options.resolveAccountRuntime ??
    getAccountRuntime;
  const resolveTurnEntitlement = options.resolveTurnEntitlement ??
    (async (c: Context<AppEnv>, accountId: string) =>
      (await new BillingEntitlementReader(
        new MongoBillingStore(await c.get("getDb")()),
      ).read(accountId)).turn);
  const fetcher = options.fetch ?? fetch;
  const resolveTurnMeter = options.resolveTurnMeter ??
    (async (c: Context<AppEnv>) =>
      new TurnCredentialMeter(
        new MongoBillingStore(await c.get("getDb")()),
      ));
  const resolveConfig: NonNullable<RtcRouteOptions["resolveConfig"]> =
    options.resolveConfig ?? ((c) => getConfig(c));
  app.onError(handleAccountError);

  app.post(
    "/v1/rtc/official",
    xmclAuth(["account:read"], resolveAccountRuntime),
    async (c) => {
      const accountId = c.get("xmclPrincipal")!.accountId;
      if (!(await resolveTurnEntitlement(c, accountId))) {
        return c.json({ stuns: STUNS, uris: [], servers: [] });
      }

      const config = resolveConfig(c);
      const meteredCloudflareTurn = !!(
        config.CLOUDFLARE_API_TOKEN && config.CLOUDFLARE_APP_ID &&
        config.CLOUDFLARE_ACCOUNT_ID &&
        config.CLOUDFLARE_ANALYTICS_API_TOKEN
      );
      if (meteredCloudflareTurn) {
        const customIdentifier = `xmcl_${
          crypto.randomUUID().replaceAll("-", "")
        }`;
        const meter = await resolveTurnMeter(c);
        const authorized = await meter.authorize(
          accountId,
          customIdentifier,
          CREDENTIAL_TTL_SECONDS,
        );
        if (!authorized) {
          return c.json({ stuns: STUNS, uris: [], servers: [] });
        }
        try {
          const cloudflare = await getCloudflareTurnServers(
            config.CLOUDFLARE_APP_ID!,
            config.CLOUDFLARE_API_TOKEN!,
            customIdentifier,
            fetcher,
          );
          if (cloudflare.length === 0) {
            await meter.release(customIdentifier);
          }
          return c.json({
            stuns: STUNS,
            uris: [],
            servers: cloudflare,
          });
        } catch (error) {
          await meter.release(customIdentifier);
          console.error({
            event: "rtc.cloudflare_api_error",
            errorName: error instanceof Error ? error.name : "UnknownError",
          });
          return c.json({ stuns: STUNS, uris: [], servers: [] });
        }
      }

      const builtin = config.RTC_SECRET
        ? await getBuiltinTurnCredentials(
          accountId,
          config.RTC_SECRET,
          parseTurns(config.TURNS),
        )
        : undefined;
      return c.json({
        stuns: STUNS,
        ...(builtin ?? { uris: [] }),
        servers: builtin?.servers ?? [],
      });
    },
  );
  return app;
}

export default createRtcRoutes();
