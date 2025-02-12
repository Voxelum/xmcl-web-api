import { Router } from "oak";
import { hasherMiddlware } from "../middlewares/hasher.ts";

const cache = [
  {
    "minecraft": "1.21.2",
    "id": "1.21.2-authlib"
  },
  {
    "minecraft": "1.21",
    "id": "1.20.5-1.21-authlib"
  },
  {
    "minecraft": "1.20.5",
    "id": "1.20.5-1.21-authlib"
  },
  {
    "minecraft": "1.20.3",
    "id": "1.20.3-authlib"
  },
  {
    "minecraft": "1.20.2",
    "id": "1.20.2-authlib"
  },
  {
    "minecraft": "1.20",
    "id": "1.20-authlib"
  },
  {
    "minecraft": "1.19.4",
    "id": "1.19.4-authlib"
  },
  {
    "minecraft": "1.19.3",
    "id": "1.19.3-authlib"
  },
  {
    "minecraft": "1.19.2",
    "id": "1.19.2-authlib"
  },
  {
    "minecraft": "1.19.1",
    "id": "1.19.1-authlib"
  },
  {
    "minecraft": "1.19",
    "id": "1.19-authlib"
  },
  {
    "minecraft": "1.18.2",
    "id": "1.18.2-authlib"
  },
  {
    "minecraft": "1.18",
    "id": "1.18-authlib"
  },
  {
    "minecraft": "1.17",
    "id": "1.17-authlib"
  },
  {
    "minecraft": "1.16.4",
    "id": "1.16.4-authlib"
  },
  {
    "minecraft": "1.16",
    "id": "1.16-authlib"
  },
  {
    "minecraft": "1.15",
    "id": "1.12-1.15-authlib"
  },
  {
    "minecraft": "1.14",
    "id": "1.12-1.15-authlib"
  },
  {
    "minecraft": "1.13",
    "id": "1.12-1.15-authlib"
  },
  {
    "minecraft": "1.12",
    "id": "1.12-1.15-authlib"
  },
  {
    "minecraft": "1.11",
    "id": "1.11-authlib"
  },
  {
    "minecraft": "1.10",
    "id": "1.9-1.10-authlib"
  },
  {
    "minecraft": "1.9",
    "id": "1.9-1.10-authlib"
  },
  {
    "minecraft": "1.8",
    "id": "1.7.10-1.8-authlib"
  },
  {
    "minecraft": "1.7.10",
    "id": "1.7.10-1.8-authlib"
  },
  {
    "minecraft": "1.7.9",
    "id": "1.7.9-authlib"
  },
  {
    "minecraft": "1.7.8",
    "id": "1.7.8-authlib"
  },
  {
    "minecraft": "1.7.2",
    "id": "1_7_2_forge",
    "canForge": true
  },
  {
    "minecraft": "1.7.2",
    "id": "1_7_2"
  },
  {
    "minecraft": "1.6.4",
    "id": "1_6_4_forge",
    "canForge": true
  },
  {
    "minecraft": "1.6.4",
    "id": "1_6_4"
  },
  {
    "minecraft": "1.5.2",
    "id": "1_5_2"
  },
  {
    "minecraft": "1.4.7",
    "id": "1_4_7"
  },
  {
    "minecraft": "1.3.2",
    "id": "1_3_2"
  },
  {
    "minecraft": "1.2.5",
    "id": "1_2_5"
  }
]
export default new Router().use(hasherMiddlware).get("/elyby/authlib", async (ctx) => {
  const etag = ctx.state.hasher.hash(JSON.stringify(cache), 'hex');
  if (ctx.request.headers.get('if-none-match') === etag) {
    ctx.response.status = 304
  } else {
    ctx.response.headers.set('etag', etag as string);
    ctx.response.body = cache;
  }
});
