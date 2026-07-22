// deno-lint-ignore-file no-explicit-any
import { Hono } from "hono";
import { getConfig } from "../config.ts";
import type { Db } from "../db.ts";
import { minecraftAuth } from "../middleware/auth.ts";

import type { AppEnv } from "../types.ts";

async function hmacSha1Base64(
  secret: string,
  message: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(message),
  );
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

function parseTurns(
  turns: string | undefined,
): Array<{ ip: string; realm: string }> {
  try {
    const pairs = turns?.split(",").map((p) => p.split(":"));
    return pairs?.map(([realm, ip]) => ({ ip, realm })) ?? [];
  } catch (e) {
    console.error(e);
    return [];
  }
}

async function getTURNCredentials(
  name: string,
  secret: string,
  turns: Array<{ ip: string; realm: string }>,
) {
  const unixTimeStamp = Math.floor(Date.now() / 1000) + 24 * 3600;
  const username = [unixTimeStamp, name].join(":");
  const password = await hmacSha1Base64(secret, username);

  const result = {
    username,
    password,
    ttl: 86400,
    uris: ["turn:20.239.69.131", "turn:20.199.15.21", "turn:20.215.243.212"],
    meta: {
      ["20.239.69.131"]: "hk",
      ["20.199.15.21"]: "fr",
      ["20.215.243.212"]: "po",
    } as Record<string, string>,
  };

  for (const turn of turns) {
    result.uris.push(`turn:${turn.ip}`);
    result.meta[turn.ip] = turn.realm;
  }

  return result;
}

async function ensureAccount(db: Db, name: string, namespace: string) {
  const collection = db.collection("turnusers_lt");
  await collection.updateOne(
    { name: `${namespace}:${name}`, realm: "xmcl" },
    {
      $set: {
        name: `${namespace}:${name}`,
        realm: "xmcl",
        hmackey: "5eb36f16f3bca1acf48639d9919c5094",
      },
    },
    { upsert: true },
  );
}

const stuns = [
  "stun.miwifi.com:3478",
  "stun.l.google.com:19302",
  "stun2.l.google.com:19302",
  "stun3.l.google.com:19302",
  "stun4.l.google.com:19302",
  "stun.voipbuster.com:3478",
  "stun.voipstunt.com:3478",
  "stun.internetcalls.com:3478",
  "stun.voip.aebc.com:3478",
  "stun.qq.com:3478",
];

export default new Hono<AppEnv>().post(
  "/rtc/official",
  minecraftAuth(false),
  async (c) => {
    const config = getConfig(c);
    const turns = parseTurns(config.TURNS);

    const tryGetCred = async () => {
      if (!config.RTC_SECRET) {
        console.warn("No RTC_SECRET");
        return undefined;
      }
      try {
        const profile = c.get("minecraftProfile");
        if (profile) {
          const db = await c.var.getDb();
          await ensureAccount(db, profile.id, "official");
          return await getTURNCredentials(profile.id, config.RTC_SECRET, turns);
        }
        return undefined;
      } catch (e) {
        console.error(e);
        return undefined;
      }
    };

    const tryGetCredCloudflare = async () => {
      if (!config.CLOUDFLARE_API_TOKEN || !config.CLOUDFLARE_APP_ID) {
        console.warn("No CLOUDFLARE_API_TOKEN or CLOUDFLARE_APP_ID");
        return undefined;
      }
      try {
        const response = await fetch(
          `https://rtc.live.cloudflare.com/v1/turn/keys/${config.CLOUDFLARE_APP_ID}/credentials/generate-ice-servers`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.CLOUDFLARE_API_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ ttl: 86400 }),
          },
        );
        const data = (await response.json()) as {
          iceServers: Array<
            { urls: string | string[]; username: string; credential: string }
          >;
        };
        if (response.ok) {
          let cfStuns: string[] = [];
          for (const server of data.iceServers) {
            if (server.username) {
              return {
                username: server.username,
                password: server.credential,
                uris: Array.isArray(server.urls) ? server.urls : [server.urls],
                ttl: 86400,
                meta: {} as Record<string, string>,
                stuns: cfStuns,
              };
            } else {
              cfStuns =
                (Array.isArray(server.urls) ? server.urls : [server.urls]).map((
                  u,
                ) => u.replace(/^stun:/, ""));
            }
          }
        } else {
          console.error("Cloudflare API error:", data);
        }
        return undefined;
      } catch (e) {
        console.error("Cloudflare API error:", e);
        return undefined;
      }
    };

    const cred = c.req.query("type") === "cloudflare"
      ? await tryGetCredCloudflare()
      : await tryGetCred();

    if (cred) {
      return c.json({ stuns, ...(cred as any) });
    }
    return c.json({ stuns, uris: [] });
  },
);
