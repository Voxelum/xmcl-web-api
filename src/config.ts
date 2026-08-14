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
  /** Cloudflare Calls TURN key identifier used to issue ICE credentials. */
  CLOUDFLARE_TURN_KEY_ID?: string;
  /** Token restricted to issuing Cloudflare Calls TURN credentials. */
  CLOUDFLARE_TURN_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  /** Read-only token restricted to Cloudflare Calls TURN analytics. */
  CLOUDFLARE_TURN_ANALYTICS_API_TOKEN?: string;
  /** @deprecated Use CLOUDFLARE_TURN_API_TOKEN. */
  CLOUDFLARE_API_TOKEN?: string;
  /** @deprecated Use CLOUDFLARE_TURN_KEY_ID. */
  CLOUDFLARE_APP_ID?: string;
  /** @deprecated Use CLOUDFLARE_TURN_ANALYTICS_API_TOKEN. */
  CLOUDFLARE_ANALYTICS_API_TOKEN?: string;
  CURSEFORGE_KEY?: string;
  TURNS?: string;
  MONGO_CONNECION_STRING?: string;
  MONGODB_NAME?: string;
  XMCL_DEPLOYMENT_ENVIRONMENT?: "staging" | "production";
  XMCL_HOME_RELEASE_ENABLED?: "true" | "false";
  /** Discord webhook used only for privacy-safe operational alerts. */
  XMCL_STAGING_DISCORD_ALERT_WEBHOOK_URL?: string;
  /** Production Discord webhook used only for privacy-safe operational alerts. */
  XMCL_PRODUCTION_DISCORD_ALERT_WEBHOOK_URL?: string;
  /**
   * Base URL of the community content i18n repo served as raw files, laid out
   * as `<base>/<locale>/<id>.json`. Checked before the Mongo caches. Defaults
   * to the public `Voxelum/xmcl-community-content-i18n-extra` repo.
   */
  TRANSLATION_I18N_BASE?: string;
  /**
   * Full HTTPS Azure Table URL, including its SAS query, for translation
   * cache, access heat, and scheduled-refresh state.
   */
  AZURE_TRANSLATION_TABLE_URL?: string;
  /** Maximum translation entities processed by one scheduled invocation. */
  TRANSLATION_SCHEDULED_BATCH_LIMIT?: string;
  /**
   * Server-only JSON array of Agnes API keys used by the authenticated
   * OpenAI-compatible chat proxy.
   */
  AGNES_API_KEYS?: string;
  DEEPSEEK_API_KEYS?: string;
  DEEPSEEK_DEFAULT_MODEL?: string;
  /** Default model when a chat-completions request omits `model`. */
  AGNES_DEFAULT_MODEL?: string;
  XMCL_SESSION_SECRET?: string;
  /** New signing key during a zero-downtime session-key rotation. */
  XMCL_SESSION_SECRET_PRIMARY?: string;
  XMCL_MULTIPLAYER_TICKET_SECRET?: string;
  XMCL_MICROSOFT_CLIENT_ID?: string;
  XMCL_MICROSOFT_CLIENT_SECRET?: string;
  XMCL_MODRINTH_CLIENT_ID?: string;
  XMCL_MODRINTH_CLIENT_SECRET?: string;
  /** Legacy complete Authorization value used by the launcher Modrinth exchange. */
  MODRINTH_SECRET?: string;
  XMCL_GOOGLE_CLIENT_ID?: string;
  XMCL_GOOGLE_CLIENT_SECRET?: string;
  XMCL_DISCORD_CLIENT_ID?: string;
  XMCL_DISCORD_CLIENT_SECRET?: string;
  /** ISO-4217 settlement currency for the durable billing ledger. Defaults to USD. */
  BILLING_CURRENCY?: string;
  /** JSON array of versioned CashRate records. Required before billing is composed. */
  BILLING_RATES_JSON?: string;
  /** Waffo merchant API key identity used only by server-side checkout calls. */
  WAFFO_MERCHANT_ID?: string;
  /** RSA private key paired with WAFFO_MERCHANT_ID. Never expose to clients. */
  WAFFO_PRIVATE_KEY?: string;
  /** Store that owns the configured top-up product and accepted webhooks. */
  WAFFO_STORE_ID?: string;
  /** One-time product used with a server-calculated priceSnapshot for top-ups. */
  WAFFO_PRODUCT_ID?: string;
  /** Expected webhook mode. Required to keep test and production credits isolated. */
  WAFFO_ENVIRONMENT?: "test" | "prod";
  /** Optional redirect after the hosted Waffo checkout succeeds. */
  WAFFO_SUCCESS_URL?: string;
  /** Optional API override, primarily for controlled integration tests. */
  WAFFO_API_BASE_URL?: string;
  /** Optional explicit Waffo webhook key; otherwise the SDK's built-in keys are used. */
  WAFFO_WEBHOOK_PUBLIC_KEY?: string;
  /** Exact browser origins allowed to use the isolated staging billing API. */
  XMCL_STAGING_BILLING_CORS_ORIGINS?: string;
  /**
   * High-entropy bearer credential for the isolated, read-only staging
   * operations console. Configure it as a Worker secret, never as a plain var.
   */
  XMCL_STAGING_ADMIN_ACCESS_TOKEN?: string;
  XMCL_STAGING_ADMIN_SESSION_SECRET?: string;
  /** Comma-separated verified OAuth emails allowed to mint staging admin sessions. */
  XMCL_STAGING_ADMIN_EMAILS?: string;
  /** High-entropy HMAC secret for short-lived production admin sessions. */
  XMCL_ADMIN_SESSION_SECRET?: string;
  /** Comma-separated verified OAuth emails allowed to access production admin. */
  XMCL_ADMIN_EMAILS?: string;
  /**
   * Optional comma-separated exact HTTPS callbacks for website OAuth.
   * Launcher loopback callbacks are code-owned and require no configuration.
   */
  XMCL_OAUTH_REDIRECT_URIS?: string;
  VULTR_API_TOKEN?: string;
  /** Vendor-neutral logical regions enabled for shared hosting. */
  XMCL_SHARED_NODE_REGION_IDS?: string;
  /**
   * `vultr` provisions capacity dynamically; `preprovisioned` accepts only
   * nodes enrolled by operators.
   */
  XMCL_SHARED_NODE_CAPACITY_MODE?: "vultr" | "preprovisioned";
  VULTR_SHARED_NODE_REGION_ID?: string;
  /** Optional comma-separated regional pools; defaults to REGION_ID only. */
  VULTR_SHARED_NODE_REGION_IDS?: string;
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
  XMCL_SHARED_NODE_CONTAINER_IMAGE?: string;
  XMCL_WORKSPACE_ROOT?: string;
  XMCL_RCON_STOP_TIMEOUT_SECONDS?: string;
  XMCL_XFS_PROJECT_BASE?: string;
  VULTR_SHARED_NODE_BLOCK_STORAGE_GIB?: string;
  VULTR_SHARED_NODE_BLOCK_STORAGE_TYPE?: string;
  VULTR_SHARED_NODE_FIREWALL_GROUP_ID?: string;
  /** LightNode OpenAPI credential used by operator tooling and discovery. */
  LIGHTNODE_API_TOKEN?: string;
  LIGHTNODE_API_BASE_URL?: string;
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
