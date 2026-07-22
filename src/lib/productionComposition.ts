import type { Hono } from "hono";
import { createApp, type CreateAppOptions } from "../app.ts";
import type { AppConfig } from "../config.ts";
import type { AppEnv } from "../types.ts";

export class CommercialCompositionConfigurationError extends Error {
  constructor() {
    super(
      "XMCL_COMMERCIAL_ENABLED=true requires concrete durable adapters for billing, server control, worker, AI requests, AI usage settlement, AI provider, modpack storage, modpack dispatch, and modpack deployment. This deployment has no complete commercial composition.",
    );
  }
}

export function productionAppOptions(config: AppConfig): CreateAppOptions {
  if (config.XMCL_COMMERCIAL_ENABLED === "true") {
    throw new CommercialCompositionConfigurationError();
  }
  return { commercialRoutes: false };
}

/**
 * Builds production entry points without test doubles. Account/session routes
 * remain available through their Mongo-backed runtime; commercial routes stay
 * unmounted until all of their durable adapters can be composed.
 */
export function createProductionApp(
  config: AppConfig,
  register?: (app: Hono<AppEnv>) => void,
) {
  return createApp(register, productionAppOptions(config));
}
