import { Database } from "https://deno.land/x/mongo@v0.31.1/mod.ts";
import { MongoClient } from "https://deno.land/x/mongo@v0.31.1/src/client.ts";
import { Middleware, Status } from "oak";

export interface MongoDbState {
  getDatabase(): Promise<Database>;
}
const client = new MongoClient();
let database: Database | undefined;

export const mongoDbMiddleware: Middleware<MongoDbState> = async (
  ctx,
  next,
) => {
  try {
    ctx.state.getDatabase = getDatabase;
  } catch (e) {
    console.error("Error connecting to MongoDB")
    console.error(e);
    ctx.throw(Status.Unauthorized);
  }
  await next();
};

export async function getDatabase() {
  if (database) {
    return database;
  }
  database = await client.connect(Deno.env.get("MONGO_CONNECION_STRING")!);
  return database;
}
