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
    | "CLOUDFLARE_TURN_API_TOKEN"
    | "CLOUDFLARE_TURN_KEY_ID"
    | "CLOUDFLARE_TURN_ANALYTICS_API_TOKEN"
    | "CLOUDFLARE_API_TOKEN"
    | "CLOUDFLARE_APP_ID"
    | "CLOUDFLARE_ACCOUNT_ID"
    | "CLOUDFLARE_ANALYTICS_API_TOKEN"
  >;
}

async function getCloudflareTurnServers(
  keyId: string,
  apiToken: string,
  customIdentifier: string,
  ttlSeconds: number,
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
        ttl: ttlSeconds,
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
      const cloudflareTurnToken = config.CLOUDFLARE_TURN_API_TOKEN ??
        config.CLOUDFLARE_API_TOKEN;
      const cloudflareTurnKeyId = config.CLOUDFLARE_TURN_KEY_ID ??
        config.CLOUDFLARE_APP_ID;
      const cloudflareTurnAnalyticsToken =
        config.CLOUDFLARE_TURN_ANALYTICS_API_TOKEN ??
          config.CLOUDFLARE_ANALYTICS_API_TOKEN;
      const meteredCloudflareTurn = !!(
        cloudflareTurnToken && cloudflareTurnKeyId &&
        config.CLOUDFLARE_ACCOUNT_ID &&
        cloudflareTurnAnalyticsToken
      );
      if (meteredCloudflareTurn) {
        const customIdentifier = `xmcl_${
          crypto.randomUUID().replaceAll("-", "")
        }`;
        const meter = await resolveTurnMeter(c);
        const authorization = await meter.authorize(
          accountId,
          customIdentifier,
          CREDENTIAL_TTL_SECONDS,
        );
        if (!authorization) {
          return c.json({ stuns: STUNS, uris: [], servers: [] });
        }
        try {
          const cloudflare = await getCloudflareTurnServers(
            cloudflareTurnKeyId!,
            cloudflareTurnToken!,
            authorization.customIdentifier,
            authorization.ttlSeconds,
            fetcher,
          );
          if (cloudflare.length === 0 && authorization.created) {
            await meter.release(authorization.customIdentifier);
          }
          return c.json({
            stuns: STUNS,
            uris: [],
            servers: cloudflare,
          });
        } catch (error) {
          if (authorization.created) {
            await meter.release(authorization.customIdentifier);
          }
          console.error({
            event: "rtc.cloudflare_api_error",
            errorName: error instanceof Error ? error.name : "UnknownError",
          });
          return c.json({ stuns: STUNS, uris: [], servers: [] });
        }
      }

      console.warn({
        event: "rtc.turn_metering_unavailable",
        accountId,
      });
      return c.json({ stuns: STUNS, uris: [], servers: [] });
    },
  );
  return app;
}

export default createRtcRoutes();
