// deno-lint-ignore-file no-explicit-any
import { MongoClient } from "mongo";
import type { AppConfig } from "../config.ts";
import type { Db, DbFactory, MongoCollection } from "../db.ts";

/**
 * Deno-native MongoDB driver. Handles Azure Cosmos DB SCRAM-SHA-1
 * authentication correctly on Deno Deploy (the npm driver does not).
 */
let dbPromise: Promise<Db> | undefined;

function connect(config: AppConfig): Promise<Db> {
  const connStr = config.MONGO_CONNECION_STRING ||
    Deno.env.get("MONGO_CONNECION_STRING");
  if (!connStr) {
    throw new Error("MONGO_CONNECION_STRING is not set");
  }
  const client = new MongoClient();
  return client.connect(connStr).then(() => {
    const db = client.database(config.MONGODB_NAME || "coturn");
    return {
      collection(name: string): MongoCollection {
        const coll = db.collection(name);
        return {
          findOne(filter: Record<string, unknown>) {
            return coll.findOne(filter as any);
          },
          updateOne(
            filter: Record<string, unknown>,
            update: Record<string, unknown>,
            options?: { upsert?: boolean },
          ) {
            return coll.updateOne(filter as any, update as any, options);
          },
          replaceOne(
            filter: Record<string, unknown>,
            replacement: Record<string, unknown>,
            options?: { upsert?: boolean },
          ) {
            return coll.replaceOne(filter as any, replacement as any, options);
          },
          deleteOne(filter: Record<string, unknown>) {
            return coll.deleteOne(filter as any);
          },
        };
      },
    };
  });
}

export const getDb: DbFactory = (config) => {
  if (!dbPromise) {
    dbPromise = connect(config).catch((e) => {
      dbPromise = undefined;
      throw e;
    });
  }
  return dbPromise;
};
