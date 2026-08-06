// deno-lint-ignore-file no-explicit-any
import type { AppConfig } from "./config.ts";
import type { Db, DbFactory, MongoCollection } from "./db.ts";

/**
 * Native MongoDB driver. The module is loaded inside `connect` so Workers do
 * not evaluate BSON before a request. MongoDB 6 with nodejs_compat_v2 uses
 * workerd's supported Node socket APIs; the BSON 7 browser bundle does not.
 */
let dbPromise: Promise<Db> | undefined;
const DB_CONNECT_TIMEOUT_MS = 10_000;

function withConnectionTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Mongo connection timed out after 10000ms")),
      DB_CONNECT_TIMEOUT_MS,
    );
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function connect(config: AppConfig): Promise<Db> {
  let clientUrl = config.MONGO_CONNECION_STRING;
  if (!clientUrl) {
    throw new Error("MONGO_CONNECION_STRING is not set");
  }
  // Cosmos DB requires SCRAM-SHA-1
  if (!clientUrl.includes("authMechanism=")) {
    clientUrl += (clientUrl.includes("?") ? "&" : "?") +
      "authMechanism=SCRAM-SHA-1";
  }
  // URL-encode credentials for strict drivers
  const m = clientUrl.match(/^(mongodb(?:\+srv)?:\/\/)([^:]+):([^@]+)@(.+)$/);
  if (m) {
    const [, scheme, user, pass, rest] = m;
    clientUrl = `${scheme}${encodeURIComponent(user)}:${
      encodeURIComponent(pass)
    }@${rest}`;
  }
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(clientUrl, {
    retryWrites: false,
    connectTimeoutMS: DB_CONNECT_TIMEOUT_MS,
    serverSelectionTimeoutMS: DB_CONNECT_TIMEOUT_MS,
    socketTimeoutMS: DB_CONNECT_TIMEOUT_MS,
  });
  await withConnectionTimeout(client.connect());
  const database = client.db(config.MONGODB_NAME || "coturn");
  return {
    collection(name: string): MongoCollection {
      return database.collection(name) as unknown as MongoCollection;
    },
  };
}

/**
 * Creates a new driver connection. Cloudflare Workers must use this per
 * request: Node Mongo driver's I/O objects are request-context-bound there and
 * cannot be reused by another Worker request.
 */
export const createDb: DbFactory = (config) => connect(config);

/** Shared connection factory for long-lived Node/Azure processes. */
export const getDb: DbFactory = (config) => {
  if (!dbPromise) {
    dbPromise = connect(config).catch((e) => {
      dbPromise = undefined;
      throw e;
    });
  }
  return dbPromise;
};
