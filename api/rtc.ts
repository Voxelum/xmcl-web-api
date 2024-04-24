import { hmac } from "https://deno.land/x/hmac@v2.0.1/mod.ts";
import { Database } from "https://deno.land/x/mongo@v0.31.1/mod.ts";
import {
  composeMiddleware,
  Router,
} from "oak";
import {
  getMinecraftAuthMiddleware,
  MinecraftAuthState,
} from "../middlewares/minecraftAuth.ts";
import { mongoDbMiddleware, MongoDbState } from "../middlewares/mongoDb.ts";

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

const stuns = [
  "stun.miwifi.com",
  "stun.l.google.com",
]

const secret = Deno.env.get("RTC_SECRET");
const router = new Router();
if (secret) {
  router.post(
    "/rtc/official",
    composeMiddleware<Partial<MinecraftAuthState> & MongoDbState>([
      getMinecraftAuthMiddleware(false),
      mongoDbMiddleware,
    ]),
    async (context) => {
      const tryGetCred = async () => {
        try {
          if (context.state.profile) {
            const id = context.state.profile.id;
            await ensureAccount(
              await context.state.getDatabase(),
              id,
              "official",
            );
            const creds = getTURNCredentials(id, secret);
            return creds
          }
          return undefined
        } catch (e) {
          console.error(e);
          return undefined
        }
      }

      const cred = await tryGetCred()
      if (cred) {
        return {
          ...cred,
          stuns,
        }
      }
      return {
        stuns,
      }
    },
  );
}

export default router;
