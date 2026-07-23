import type { Hono } from "hono";
import { createApp, type CreateAppOptions } from "../app.ts";
import type { AppEnv } from "../types.ts";

export function productionAppOptions(): CreateAppOptions {
  return { commercialRoutes: false };
}

/**
 * Builds production entry points without test doubles. Account/session routes
 * remain available through their Mongo-backed runtime; commercial routes stay
 * unmounted until all of their durable adapters can be composed.
 */
export function createProductionApp(
  register?: (app: Hono<AppEnv>) => void,
) {
  return createApp(register, productionAppOptions());
}
