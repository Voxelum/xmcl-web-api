// deno-lint-ignore-file no-explicit-any
import { MikroORM } from "@mikro-orm/mongodb";
import type { AppConfig } from "../config.ts";
import type { Db, DbFactory, MongoCollection } from "../db.ts";

/**
 * npm MongoDB driver via MikroORM. Works on Cloudflare Workers, Node.js, Bun,
 * and Azure Functions. Does NOT work with Cosmos DB on Deno Deploy (use
 * db_deno.ts there instead).
 */
let dbPromise: Promise<Db> | undefined;

function connect(config: AppConfig): Promise<Db> {
  let clientUrl = config.MONGO_CONNECION_STRING;
  if (!clientUrl) {
    throw new Error("MONGO_CONNECION_STRING is not set");
  }
  // Cosmos DB requires SCRAM-SHA-1
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
    dbName: config.MONGODB_NAME || "coturn",
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
