import { hmac } from "https://deno.land/x/hmac@v2.0.1/mod.ts";
import { Database } from "https://deno.land/x/mongo@v0.31.1/mod.ts";
import {
  composeMiddleware,
  Router,
  Status,
} from "https://deno.land/x/oak@v11.1.0/mod.ts";
import {
  minecraftAuthMiddleware,
  MinecraftAuthState,
} from "../middlewares/minecraftAuth.ts";
import { mongoDbMiddleware, MongoDbState } from "../middlewares/mongoDb.ts";
import { defineApi } from "../type.ts";

function getTURNCredentials(name: string, secret: string) {
  const unixTimeStamp = Math.floor(Date.now() / 1000) + 24 * 3600;

  const username = [unixTimeStamp, name].join(":");
  const password = hmac("sha1", secret, username, "utf-8", "base64");

  return {
    username,
    password,
    ttl: 86400,
    uris: [
      "turn:20.239.69.131",
    ],
  };
}

async function ensureAccount(
  database: Database,
  name: string,
  namespace: string,
) {
  const collection = database.collection("turnusers_lt");
  await collection.updateOne({
    name: `${namespace}:${name}`,
    realm: "xmcl",
  }, {
    $set: {
      name: `${namespace}:${name}`,
      realm: "xmcl",
      hmackey: "5eb36f16f3bca1acf48639d9919c5094",
    },
  }, {
    upsert: true,
  });
}

export default defineApi(
  (router: Router) => {
    const secret = Deno.env.get("RTC_SECRET");
    if (secret) {
      router.post(
        "/rtc/official",
        composeMiddleware<MinecraftAuthState & MongoDbState>([
          minecraftAuthMiddleware,
          mongoDbMiddleware,
        ]),
        async (context) => {
          try {
            const id = context.state.profile.id;
            await ensureAccount(
              await context.state.getDatabase(),
              id,
              "official",
            );
            context.response.body = getTURNCredentials(id, secret);
          } catch (e) {
            console.error(e);
            context.throw(Status.Unauthorized);
          }
        },
      );

      router.post(
        "/rtc/microsoft",
        composeMiddleware<MinecraftAuthState & MongoDbState>([
          minecraftAuthMiddleware,
          mongoDbMiddleware,
        ]),
        async (context) => {
          try {
            const id = context.state.profile.id;
            await ensureAccount(
              await context.state.getDatabase(),
              id,
              "microsoft",
            );
            context.response.body = getTURNCredentials(id, secret);
          } catch (e) {
            console.error(e);
            context.throw(Status.Unauthorized);
          }
        },
      );
    }
  },
);
