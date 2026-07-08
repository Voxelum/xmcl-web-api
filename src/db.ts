// deno-lint-ignore-file no-explicit-any
import type { AppConfig } from "./config.ts";

/** The subset of the native MongoDB collection API the routes rely on. */
export interface MongoCollection {
  findOne(filter: Record<string, unknown>): Promise<any>;
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { upsert?: boolean },
  ): Promise<unknown>;
  replaceOne(
    filter: Record<string, unknown>,
    replacement: Record<string, unknown>,
    options?: { upsert?: boolean },
  ): Promise<unknown>;
  deleteOne(filter: Record<string, unknown>): Promise<unknown>;
}

export interface Db {
  collection(name: string): MongoCollection;
}

/**
 * Factory type for creating a Db connection. Each platform provides its own
 * implementation and injects it via middleware.
 */
export type DbFactory = (config: AppConfig) => Promise<Db>;
