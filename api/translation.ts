
import {
  Router,
  Status,
  composeMiddleware,
} from "oak";
import { WithHasher, hasherMiddlware } from "../middlewares/hasher.ts";
import { WithKv, kvMiddlware } from "../middlewares/kv.ts";
import {
  MinecraftAuthState,
} from "../middlewares/minecraftAuth.ts";
import { MongoDbState, mongoDbMiddleware } from "../middlewares/mongoDb.ts";
import { ModrinthResponseBody } from "../utils/chatgpt.ts";
import { translatev2 } from "../utils/translationv2.ts";
import { translate } from "../utils/translation.ts";


export default new Router().get(
  "/translation",
  composeMiddleware<MinecraftAuthState & MongoDbState & WithHasher & WithKv>([
    hasherMiddlware,
    kvMiddlware,
    mongoDbMiddleware,
  ]),
  async (ctx) => {
    async function getCurseforgeDescription(id: string) {
      const url = new URL(
        `https://api.curseforge.com/v1/mods/${id}/description`,
      );
      const response = await fetch(url, {
        headers: {
          ...ctx.request.headers,
          'x-api-key': Deno.env.get('CURSEFORGE_KEY')!,
        },
      });

      if (!response.ok) {
        throw ctx.throw(response.status as any, await response.text());
      }

      const body = await response.json() as { data: string }

      return body.data;
    }

    async function getModrinthDescrption(id: string) {
      const url = new URL(
        `https://api.modrinth.com/v2/project/${id}`,
      );
      const response = await fetch(url, {
        headers: ctx.request.headers,
      });

      if (!response.ok) {
        throw ctx.throw(response.status as any, await response.text());
      }

      const body = await response.json() as ModrinthResponseBody;

      return body.body;
    }

    const type = ctx.request.url.searchParams.get("type");
    if (!type) {
      return ctx.throw(Status.BadRequest, "No type specified");
    }

    if (type !== 'modrinth' && type !== 'curseforge') {
      return ctx.throw(Status.BadRequest, "Invalid type");
    }

    const id = ctx.request.url.searchParams.get("id");
    if (!id) {
      return ctx.throw(Status.BadRequest, "No id specified");
    }

    const langs = ctx.request.acceptsLanguages();
    if (!langs) {
      return ctx.throw(Status.BadRequest, "No language specified");
    }

    const lang = langs[0];

    if (!lang) {
      return ctx.throw(Status.BadRequest, "No language specified");
    }

    const db = await ctx.state.getDatabase();

    const body = type === 'curseforge' ? await getCurseforgeDescription(id) : await getModrinthDescrption(id);
    const contentType = type === 'curseforge' ? 'text/html' : 'text/markdown';

    if (lang === '*' || lang.startsWith('en')) {
      ctx.response.status = 204;
      ctx.response.body = '';
      return
    }

    const bodyHash = ctx.state.hasher.hash(body);
    const newColl = db.collection(`${lang}_translation`);

    function respond(content: string) {
      ctx.response.status = 200;
      ctx.response.body = content;
      ctx.response.headers.set("content-language", lang);
      ctx.response.headers.set('content-type', contentType);
      ctx.response.headers.set("cache-control", "public, max-age=86400");
    }

    // New way: lookup by id in `<locale>_translation`, validated by the body hash.
    const newFound = await newColl.findOne({
      _id: {
        $eq: id,
      },
    });

    if (newFound && newFound.bodyHash === bodyHash) {
      return respond(newFound.content);
    }

    // Old way: lookup by hash(body + lang) in the legacy `translated` collection.
    if (!newFound) {
      const legacyId = ctx.state.hasher.hash(body + lang);
      const legacyFound = await db.collection("translated").findOne({
        _id: {
          $eq: legacyId,
        },
      });

      if (legacyFound) {
        // Backfill the new collection with the legacy content.
        await newColl.replaceOne(
          { _id: id },
          { _id: id, bodyHash, content: legacyFound.content, contentType, type },
          { upsert: true },
        );
        return respond(legacyFound.content);
      }
    }

    const enqueueResult = await ctx.state.kv.enqueue({
      lang,
      body,
      bodyHash,
      contentType,
      type,
      id,
    })

    if (!enqueueResult.ok) {
      console.time(`translate:${id}:${contentType}`);
      const result = lang === 'ru' ? await translatev2(lang, body, contentType) : await translate(lang, body, contentType)
      console.timeLog(`translate:${id}:${contentType}`);

      if (typeof result === "object") {
        return ctx.throw(
          Status.InternalServerError,
          result.error.message,
          result.error,
        );
      }

      await newColl.replaceOne(
        { _id: id },
        { _id: id, bodyHash, content: result, contentType, type },
        { upsert: true },
      );

      respond(result);
    } else {
      ctx.response.status = 202;
      ctx.response.body = '';
    }
  },
);
