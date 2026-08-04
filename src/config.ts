import type { Context } from "hono";
import { env } from "hono/adapter";

/**
 * Strongly-typed view over the environment variables / secret bindings.
 *
 * `env(c)` (from hono/adapter) resolves values from the right place on every
 * runtime: `Deno.env` on Deno, `process.env` on Node/Azure, and the `c.env`
 * bindings on Cloudflare Workers. This replaces the direct `Deno.env.get(...)`
 * calls used by the original Oak service.
 */
export interface AppConfig {
  GITHUB_PAT?: string;
  RTC_SECRET?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_APP_ID?: string;
  CURSEFORGE_KEY?: string;
  TURNS?: string;
  MONGO_CONNECION_STRING?: string;
  MONGODB_NAME?: string;
  /**
   * Base URL of the community content i18n repo served as raw files, laid out
   * as `<base>/<locale>/<id>.json`. Checked before the Mongo caches. Defaults
   * to the public `Voxelum/xmcl-community-content-i18n-extra` repo.
   */
  TRANSLATION_I18N_BASE?: string;
  /**
   * Server-only JSON array of Agnes API keys used by the authenticated
   * OpenAI-compatible chat proxy.
   */
  AGNES_API_KEYS?: string;
  /** Default model when a chat-completions request omits `model`. */
  AGNES_DEFAULT_MODEL?: string;
  XMCL_SESSION_SECRET?: string;
  XMCL_MULTIPLAYER_TICKET_SECRET?: string;
  XMCL_MICROSOFT_CLIENT_ID?: string;
  XMCL_MICROSOFT_CLIENT_SECRET?: string;
  XMCL_MODRINTH_CLIENT_ID?: string;
  XMCL_MODRINTH_CLIENT_SECRET?: string;
  XMCL_GOOGLE_CLIENT_ID?: string;
  XMCL_GOOGLE_CLIENT_SECRET?: string;
  XMCL_DISCORD_CLIENT_ID?: string;
  XMCL_DISCORD_CLIENT_SECRET?: string;
  /** ISO-4217 settlement currency for the durable billing ledger. Defaults to USD. */
  BILLING_CURRENCY?: string;
  /** JSON array of versioned CashRate records. Required before billing is composed. */
  BILLING_RATES_JSON?: string;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_WEBHOOK_ID?: string;
  PAYPAL_RETURN_URL?: string;
  PAYPAL_CANCEL_URL?: string;
  PAYPAL_API_BASE_URL?: string;
  /** Fixed Azure control-plane URL used only by the Cloudflare PayPal proxy. */
  PAYPAL_WEBHOOK_PROXY_URL?: string;
  /** Worker-to-Azure PayPal webhook proxy workload identity key id. */
  XMCL_PAYPAL_WEBHOOK_PROXY_KEY_ID?: string;
  /** Worker-to-Azure PayPal webhook proxy HMAC secret (at least 32 UTF-8 bytes). */
  XMCL_PAYPAL_WEBHOOK_PROXY_SECRET?: string;
  /**
   * Explicit Azure-only opt-in for the staging M3 Sandbox checkout control
   * plane. Any other value leaves every M3 checkout route unmounted.
   */
  XMCL_STAGING_M3_CHECKOUT_ENABLED?: string;
  /** Fixed Azure `/api` base used only by the staging M3 Worker proxy. */
  XMCL_STAGING_M3_PROXY_URL?: string;
  /** Worker-to-Azure staging M3 API proxy workload identity key id. */
  XMCL_STAGING_M3_PROXY_KEY_ID?: string;
  /** Worker-to-Azure staging M3 API proxy HMAC secret (at least 32 UTF-8 bytes). */
  XMCL_STAGING_M3_PROXY_SECRET?: string;
  /**
   * Comma-separated exact HTTPS origins allowed to call the staging M3 API
   * from a browser. Wildcards, credentials, paths, and query strings are
   * rejected by the staging composition.
   */
  XMCL_STAGING_M3_CORS_ORIGINS?: string;
  /**
   * Explicit Azure and Worker opt-in for the staging-only M1 account/session
   * control plane. Any other value leaves the routes unavailable.
   */
  XMCL_STAGING_ACCOUNT_PROXY_ENABLED?: string;
  /** Fixed Azure `/api` base used only by the staging M1 Worker proxy. */
  XMCL_STAGING_ACCOUNT_PROXY_URL?: string;
  /** Worker-to-Azure staging M1 account/session proxy workload identity key id. */
  XMCL_STAGING_ACCOUNT_PROXY_KEY_ID?: string;
  /** Worker-to-Azure staging M1 account/session HMAC secret (at least 32 UTF-8 bytes). */
  XMCL_STAGING_ACCOUNT_PROXY_SECRET?: string;
  /**
   * Comma-separated exact staging Pages origins allowed to call the M1 API from
   * a browser. Each origin must also declare its `/oauth/callback` redirect URI.
   */
  XMCL_STAGING_ACCOUNT_PROXY_CORS_ORIGINS?: string;
  /**
   * Optional comma-separated exact HTTPS callbacks for website OAuth.
   * Launcher loopback callbacks are code-owned and require no configuration.
   */
  XMCL_OAUTH_REDIRECT_URIS?: string;
  VULTR_API_TOKEN?: string;
  VULTR_SHARED_NODE_REGION_ID?: string;
  VULTR_SHARED_NODE_PLAN?: string;
  VULTR_SHARED_NODE_IMAGE_ID?: string;
  VULTR_SHARED_NODE_TOTAL_MEMORY_MIB?: string;
  VULTR_SHARED_NODE_TOTAL_SHARED_CPU?: string;
  VULTR_SHARED_NODE_TOTAL_WORKSPACE_GIB?: string;
  XMCL_SHARED_AGENT_RELEASE_URL?: string;
  XMCL_SHARED_AGENT_RELEASE_SHA256?: string;
  XMCL_SHARED_QUOTA_HELPER_RELEASE_URL?: string;
  XMCL_SHARED_QUOTA_HELPER_RELEASE_SHA256?: string;
  XMCL_CONTROL_PLANE_URL?: string;
  XMCL_VULTR_OBJECT_STORAGE_ENDPOINT?: string;
  XMCL_VULTR_OBJECT_STORAGE_REGION?: string;
  XMCL_VULTR_OBJECT_STORAGE_BUCKET?: string;
  /** Server-only Worker secret used solely for S3 SigV4 pre-signing. */
  XMCL_VULTR_OBJECT_STORAGE_ACCESS_KEY?: string;
  /** Server-only Worker secret used solely for S3 SigV4 pre-signing. */
  XMCL_VULTR_OBJECT_STORAGE_SECRET_KEY?: string;
  /**
   * Surface used by an unmapped Cloudflare preview hostname. Production
   * custom domains always select their surface from the hostname.
   */
  XMCL_API_SURFACE?: string;
  XMCL_SHARED_NODE_CONTAINER_IMAGE?: string;
  XMCL_WORKSPACE_ROOT?: string;
  XMCL_RCON_STOP_TIMEOUT_SECONDS?: string;
  XMCL_XFS_PROJECT_BASE?: string;
  VULTR_SHARED_NODE_BLOCK_STORAGE_GIB?: string;
  VULTR_SHARED_NODE_BLOCK_STORAGE_TYPE?: string;
  VULTR_SHARED_NODE_FIREWALL_GROUP_ID?: string;
  XMCL_SHARED_NODE_INGRESS_PORT_MIN?: string;
  XMCL_SHARED_NODE_INGRESS_PORT_MAX?: string;
  /**
   * Azure-only fixed compiler worker endpoint. It must be the exact HTTPS
   * `/v1/compiler-jobs` URL; it is never accepted from a deployment request.
   */
  XMCL_SHARED_COMPILER_ENDPOINT?: string;
  /** Server-to-compiler HMAC workload identity key id. */
  XMCL_SHARED_COMPILER_KEY_ID?: string;
  /** Server-to-compiler HMAC workload identity secret (at least 32 UTF-8 bytes). */
  XMCL_SHARED_COMPILER_HMAC_SECRET?: string;
  /** Bounded Azure-to-compiler POST lifetime in milliseconds (1000–300000). */
  XMCL_SHARED_COMPILER_TIMEOUT_MS?: string;
  /**
   * Immutable reviewed compiler image reference, pinned to the approved GHCR
   * digest. Its presence is an explicit operator acknowledgement of review.
   */
  XMCL_SHARED_COMPILER_REVIEWED_IMAGE?: string;
  /** Version of the server-side Minecraft/EULA terms acceptance policy. */
  XMCL_SHARED_RUNTIME_TERMS_VERSION?: string;
}

export function getConfig(c: Context): AppConfig {
  return env<Record<string, string | undefined>>(c) as AppConfig;
}
