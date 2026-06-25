import type { Db } from "./db.ts";
import type { TranslationJob } from "./translation_service.ts";

export interface MicrosoftMinecraftProfile {
  id: string;
  name: string;
}

export interface MicrosoftProfile {
  id: string;
  userPrincipalName: string;
}

/** Per-request values shared between middleware and route handlers. */
export interface AppVariables {
  /** Lazily opens (and caches) the MongoDB connection for this isolate. */
  getDb: () => Promise<Db>;
  /** Set by the Minecraft auth middleware when a valid token is present. */
  minecraftProfile?: MicrosoftMinecraftProfile;
  /** Set by the Microsoft Graph auth middleware. */
  microsoftProfile?: MicrosoftProfile;
  /** ISO country code resolved by a platform geo middleware (Deno/Azure). */
  country?: string;
  /**
   * Offload a translation to a platform queue (Deno.Kv / Cloudflare Queue).
   * Returns true if accepted (route replies 202); absent or false means the
   * route translates inline. Azure has no queue and always translates inline.
   */
  enqueueTranslation?: (job: TranslationJob) => Promise<boolean>;
}

/**
 * Cloudflare resource bindings. Absent on Deno/Azure (where the realtime group
 * endpoint uses the native WebSocket upgrade instead of a Durable Object).
 * Secret/text vars are read through hono/adapter `env(c)` and typed in
 * `AppConfig`, so they are intentionally loose here.
 */
export interface AppBindings {
  GROUP_ROOM?: unknown;
  TRANSLATION_KV?: unknown;
  TRANSLATION_QUEUE?: unknown;
  [key: string]: unknown;
}

export type AppEnv = {
  Bindings: AppBindings;
  Variables: AppVariables;
};
