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

const isDeno = typeof (globalThis as any).Deno !== "undefined";

/**
 * Cross-runtime MongoDB connector.
 *
 * On Deno (including Deno Deploy): uses the Deno-native driver
 * (`deno.land/x/mongo`) which handles Cosmos DB SCRAM auth correctly.
 *
 * On other runtimes (Cloudflare Workers, Node.js, Bun): uses the npm `mongodb`
 * driver via MikroORM, which works fine outside of Deno Deploy.
 */
let dbPromise: Promise<Db> | undefined;

function getConnectionString(config: AppConfig): string {
  const connStr = config.MONGO_CONNECION_STRING ||
    (isDeno ? (globalThis as any).Deno.env.get("MONGO_CONNECION_STRING") : undefined);
  if (!connStr) {
    throw new Error("MONGO_CONNECION_STRING is not set");
  }
  return connStr;
}

function connectDeno(config: AppConfig): Promise<Db> {
  // Dynamic import so non-Deno bundlers never see this module
  return import("mongo").then(({ MongoClient }) => {
    const client = new MongoClient();
    return client.connect(getConnectionString(config)).then(() => {
      const db = client.database(config.MONGODB_NAME || "xmcl-api");
      return {
        collection(name: string): MongoCollection {
          const coll = db.collection(name);
          return {
            findOne(filter: Record<string, unknown>) {
              return coll.findOne(filter as any);
            },
            updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, options?: { upsert?: boolean }) {
              return coll.updateOne(filter as any, update as any, options);
            },
            replaceOne(filter: Record<string, unknown>, replacement: Record<string, unknown>, options?: { upsert?: boolean }) {
              return coll.replaceOne(filter as any, replacement as any, options);
            },
            deleteOne(filter: Record<string, unknown>) {
              return coll.deleteOne(filter as any);
            },
          };
        },
      };
    });
  });
}

function connectNpm(config: AppConfig): Promise<Db> {
  // MikroORM / npm mongodb driver for Cloudflare, Node, Bun
  return import("@mikro-orm/mongodb").then(({ MikroORM }) => {
    let clientUrl = getConnectionString(config);
    if (!clientUrl.includes("authMechanism=")) {
      clientUrl += (clientUrl.includes("?") ? "&" : "?") + "authMechanism=SCRAM-SHA-1";
    }
    // URL-encode credentials for strict drivers
    const m = clientUrl.match(/^(mongodb(?:\+srv)?:\/\/)([^:]+):([^@]+)@(.+)$/);
    if (m) {
      const [, scheme, user, pass, rest] = m;
      clientUrl = `${scheme}${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${rest}`;
    }
    return MikroORM.init({
      clientUrl,
      dbName: config.MONGODB_NAME || "xmcl-api",
      entities: [],
      discovery: { warnWhenNoEntities: false },
      driverOptions: { retryWrites: false },
    }).then((orm) => {
      const connection = orm.em.getConnection();
      return {
        collection(name: string): MongoCollection {
          return connection.getCollection(name) as unknown as MongoCollection;
        },
      };
    });
  });
}

export function getDb(config: AppConfig): Promise<Db> {
  if (!dbPromise) {
    dbPromise = (isDeno ? connectDeno(config) : connectNpm(config)).catch((e) => {
      dbPromise = undefined;
      throw e;
    });
  }
  return dbPromise;
}
