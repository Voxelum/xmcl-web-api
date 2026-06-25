// deno-lint-ignore-file no-explicit-any
import { MikroORM } from "@mikro-orm/mongodb";
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
 * MikroORM is initialised once per isolate and reused. We only use it as a
 * cross-runtime MongoDB connector (works on Deno, Node/Azure and Cloudflare
 * Workers per its JSR compatibility) and access the native collections
 * directly, so the data layout matches the original Deno service exactly
 * (`turnusers_lt`, `${lang}_translation`, `translated`).
 *
 * NOTE (Cloudflare): workerd forbids `new Function`/`eval`. Because we register
 * no entities, MikroORM's JIT hydration paths are never hit; if entities are
 * added later, run `mikro-orm compile` + `GeneratedCacheAdapter` at build time.
 */
let ormPromise: Promise<MikroORM> | undefined;

function getOrm(config: AppConfig): Promise<MikroORM> {
  if (!ormPromise) {
    const clientUrl = config.MONGO_CONNECION_STRING;
    if (!clientUrl) {
      throw new Error("MONGO_CONNECION_STRING is not set");
    }
    ormPromise = MikroORM.init({
      clientUrl,
      dbName: config.MONGODB_NAME || "xmcl-api",
      entities: [],
      discovery: { warnWhenNoEntities: false },
    }).catch((e) => {
      // Allow a later request to retry if the first connection failed.
      ormPromise = undefined;
      throw e;
    });
  }
  return ormPromise;
}

export async function getDb(config: AppConfig): Promise<Db> {
  const orm = await getOrm(config);
  const connection = orm.em.getConnection();
  return {
    collection(name: string): MongoCollection {
      return connection.getCollection(name) as unknown as MongoCollection;
    },
  };
}
