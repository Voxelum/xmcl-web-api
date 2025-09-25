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

function parseTurnsFromEnv() {
  try {
    const turns = Deno.env.get('TURNS')
    const pairs = turns?.split(',').map(p => p.split(':'))
    const result = pairs?.map(([realm, ip]) => ({ ip, realm }))
    return result || []
  } catch (e) {
    console.error(e)
    return []
  }
}
const cached = parseTurnsFromEnv()

function getTURNCredentials(name: string, secret: string) {
  const unixTimeStamp = Math.floor(Date.now() / 1000) + 24 * 3600;

  const username = [unixTimeStamp, name].join(":");
  const password = hmac("sha1", secret, username, "utf-8", "base64");

  const result = {
    username,
    password,
    ttl: 86400,
    uris: [
      "turn:20.239.69.131",
      "turn:20.199.15.21",
      "turn:20.215.243.212",
    ],
    meta: {
      ["20.239.69.131"]: "hk",
      ["20.199.15.21"]: "fr",
      ["20.215.243.212"]: "po"
    } as Record<string, string>
  };

  for (const turn of cached) {
    result.uris.push(`turn:${turn.ip}`)
    result.meta[turn.ip] = turn.realm
  }

  return result;
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
  "stun.miwifi.com:3478",
  'stun.l.google.com:19302',
  'stun2.l.google.com:19302',
  'stun3.l.google.com:19302',
  'stun4.l.google.com:19302',
  'stun.voipbuster.com:3478',
  'stun.voipstunt.com:3478',
  'stun.internetcalls.com:3478',
  'stun.voip.aebc.com:3478',
  'stun.qq.com:3478',
]

const secret = Deno.env.get("RTC_SECRET");
const cloudflareAPIToken = Deno.env.get("CLOUDFLARE_API_TOKEN");
const cloudflareAppId = Deno.env.get("CLOUDFLARE_APP_ID");
const router = new Router().post(
  "/rtc/official",
  composeMiddleware<Partial<MinecraftAuthState> & MongoDbState>([
    getMinecraftAuthMiddleware(false),
    mongoDbMiddleware,
  ]),
  async (context) => {
    const tryGetCred = async () => {
      if (!secret) {
        console.warn("No RTC_SECRET");
        return undefined
      }
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

    const tryGetCredCloudflare = async () => {
      if (!cloudflareAPIToken || !cloudflareAppId) {
        console.warn("No CLOUDFLARE_API_TOKEN or CLOUDFLARE_APP_ID");
        return undefined
      }
      try {
        const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${cloudflareAppId}/credentials/generate-ice-servers`, {
          headers: {
            'Authorization': `Bearer ${cloudflareAPIToken}`,
            'Content-Type': 'application/json',
          },
          method: 'POST',
          body: JSON.stringify({
            ttl: 86400,
          })
        })
        const data = await response.json() as { iceServers: Array<{ urls: string | string[], username: string, credential: string }> }
        if (response.ok) {
          console.log(data)
          return data.iceServers[0] ? {
            username: data.iceServers[0].username,
            password: data.iceServers[0].credential,
            uris: Array.isArray(data.iceServers[0].urls) ? data.iceServers[0].urls : [data.iceServers[0].urls],
            ttl: 86400,
            meta: {} as Record<string, string>,
          } : undefined
        } else {
          console.error("Cloudflare API error:", data);
          return undefined
        }
      } catch (e) {
        console.error("Cloudflare API error:", e);
      }
    }

    const cred = context.request.url.searchParams.get("type") === "cloudflare" ? await tryGetCredCloudflare() : await tryGetCred()
    if (cred) {
      context.response.body = {
        ...cred,
        stuns,
      }
    } else {
      context.response.body = {
        stuns,
        uris: [],
      }
    }
  },
);

export default router;
