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
  XMCL_SESSION_SECRET?: string;
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
  /**
   * Optional comma-separated exact HTTPS callbacks for website OAuth.
   * Launcher loopback callbacks are code-owned and require no configuration.
   */
  XMCL_OAUTH_REDIRECT_URIS?: string;
  VULTR_API_TOKEN?: string;
  VULTR_SHARED_NODE_REGION_ID?: string;
  VULTR_SHARED_NODE_PLAN?: string;
  VULTR_SHARED_NODE_IMAGE_ID?: string;
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
  XMCL_SHARED_NODE_INGRESS_PORT_MIN?: string;
  XMCL_SHARED_NODE_INGRESS_PORT_MAX?: string;
}

export function getConfig(c: Context): AppConfig {
  return env<Record<string, string | undefined>>(c) as AppConfig;
}
