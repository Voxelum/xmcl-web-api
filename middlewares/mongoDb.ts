import { Database } from "https://deno.land/x/mongo@v0.31.1/mod.ts";
import { MongoClient } from "https://deno.land/x/mongo@v0.31.1/src/client.ts";
import { Middleware, Status } from "https://deno.land/x/oak@v11.1.0/mod.ts";

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
    ctx.state.getDatabase = async () => {
      if (database) {
        return database;
      }
      database = await client.connect(Deno.env.get("MONGO_CONNECION_STRING")!);
      return database;
    };
  } catch (e) {
    console.error(e);
    ctx.throw(Status.Unauthorized);
  }
  await next();
};
