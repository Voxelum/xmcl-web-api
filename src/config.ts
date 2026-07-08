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
  AGNES_API_KEY?: string;
  CURSEFORGE_KEY?: string;
  MODRINTH_SECRET?: string;
  TURNS?: string;
  MONGO_CONNECION_STRING?: string;
  MONGODB_NAME?: string;
  /**
   * Base URL of the community content i18n repo served as raw files, laid out
   * as `<base>/<locale>/<id>.json`. Checked before the Mongo caches. Defaults
   * to the public `Voxelum/xmcl-community-content-i18n-extra` repo.
   */
  TRANSLATION_I18N_BASE?: string;
}

export function getConfig(c: Context): AppConfig {
  return env<Record<string, string | undefined>>(c) as AppConfig;
}
