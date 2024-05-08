
import {
  Collection,
  Document
} from "https://deno.land/x/mongo@v0.31.1/mod.ts";
import {
  Router,
  Status,
  composeMiddleware,
} from "oak";
import {
  MinecraftAuthState
} from "../middlewares/minecraftAuth.ts";
import { MongoDbState, mongoDbMiddleware } from "../middlewares/mongoDb.ts";
import { ModrinthResponseBody } from "../utils/chatgpt.ts";
import { translate } from "../utils/translation.ts";
const sha1 = async (str: string) => {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest("SHA-1", data);
  const hashHex = Array.from(new Uint16Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return hashHex;
};
async function getOrTranslate(
  id: string,
  locale: string,
  text: string,
  slug: string,
  type: 'summary' | 'description',
  domain: 'curseforge' | 'modrinth',
  textType: "markdown" | "html" | "",
  coll: Collection<Document>,
) {
  const _id = await sha1(text + locale);
  const founed = await coll.findOne({
    _id: {
      $eq: _id,
    },
  });
  if (founed) {
    return founed.content as string;
  }
  console.time(`getOrTranslate:${id}:${type}`);
  const result = await translate(locale, text, textType)
  console.timeLog(`getOrTranslate:${id}:${type}`);
  await coll.insertOne({
    _id,
    id,
    content: result,
    locale,
    slug,
    extension: textType,
    domain,
    type,
  });
  return result
}

const ensureSourceLocale = async (
  id: string,
  type: string,
  domain: string,
  text: string,
  slug: string,
  coll: Collection<Document>,
) => {
  const locale = "en";
  const _id = await sha1(text + locale);
  const founed = await coll.findOne({
    _id: {
      $eq: _id,
    },
  });
  if (!founed) {
    await coll.insertOne({
      _id,
      content: text,
      id,
      locale,
      slug,
      domain,
      type,
    });
  }
};

export default new Router().get(
  "/curseforge/(.*)",
  composeMiddleware<MinecraftAuthState & MongoDbState>([
    // getMinecraftAuthMiddleware(),
    mongoDbMiddleware,
  ]),
  async (ctx, next) => {
    const path = ctx.request.url.pathname.substring("/curseforge".length);
    if (!path) {
      ctx.response.status = 400;
    } else {
      const url = new URL(
        path + ctx.request.url.search,
        "https://api.curseforge.com",
      );
      const response = await fetch(url, {
        method: ctx.request.method,
        headers: ctx.request.headers,
        body: ctx.request.hasBody
          ? ctx.request.body.stream
          : undefined,
      });
      ctx.response.status = response.status;
      ctx.response.body =
        response.headers.get("content-type")?.startsWith("application/json")
          ? await response.json()
          : response.body;
    }
    await next();
  },
).get("/curseforge/v1/mods/:modId", async (ctx) => {
  if (ctx.params.modId === "search") return;
  const body = ctx.response.body as {
    data: { summary: string; slug: string };
  };

  const langs = ctx.request.acceptsLanguages();
  if (!langs) {
    return ctx.throw(Status.BadRequest, "No language specified");
  }

  const lang = langs[0];

  const db = await ctx.state.getDatabase();
  const coll = db.collection("translated");
  if (lang !== "*" && !lang.startsWith("en")) {
    const summary = await getOrTranslate(
      ctx.params.modId,
      lang,
      body.data.summary,
      body.data.slug,
      "summary",
      "curseforge",
      "",
      coll,
    );
    if (typeof summary === "object") {
      return ctx.throw(
        Status.InternalServerError,
        summary.error.message,
        summary.error,
      );
    }
    body.data.summary = summary;

    ctx.response.body = body;
    ctx.response.headers.set("content-language", lang);
  } else {
    await ensureSourceLocale(
      ctx.params.modId,
      "summary",
      "curseforge",
      body.data.summary,
      body.data.slug,
      coll,
    ).catch(() => { });
  }
}).get("/curseforge/v1/mods/:modId/description", async (ctx) => {
  const body = ctx.response.body as { data: string };

  const langs = ctx.request.acceptsLanguages();
  if (!langs) {
    return ctx.throw(Status.BadRequest, "No language specified");
  }

  const lang = langs[0];

  const response = await fetch(
    "https://api.curseforge.com/v1/mods/" + ctx.params.modId,
    {
      headers: ctx.request.headers,
    },
  );

  const slug = (await response.json()).data.slug;

  const db = await ctx.state.getDatabase();
  const coll = db.collection("translated");
  if (lang !== "*" && !lang.startsWith("en")) {
    const description = await getOrTranslate(
      ctx.params.modId,
      lang,
      body.data,
      slug,
      "description",
      "curseforge",
      "html",
      coll,
    );

    if (typeof description === "object") {
      return ctx.throw(
        Status.InternalServerError,
        description.error.message,
        description.error,
      );
    }

    body.data = description;
    ctx.response.body = body;
    ctx.response.headers.set("content-language", lang);
  } else {
    await ensureSourceLocale(
      ctx.params.modId,
      "summary",
      "curseforge",
      body.data,
      slug,
      coll,
    )
      .catch(() => { });
  }
}).get(
  "/modrinth/(.*)",
  composeMiddleware<MinecraftAuthState & MongoDbState>([
    // getMinecraftAuthMiddleware(),
    mongoDbMiddleware,
  ]),
  async (ctx, next) => {
    const path = ctx.request.url.pathname.substring("/modrinth".length);
    if (!path) {
      ctx.response.status = 400;
    } else {
      const url = new URL(
        path + ctx.request.url.search,
        "https://api.modrinth.com",
      );
      const response = await fetch(url, {
        method: ctx.request.method,
        headers: ctx.request.headers,
        body: ctx.request.hasBody
          ? ctx.request.body.stream
          : undefined,
      });
      ctx.response.status = response.status;
      ctx.response.body =
        response.headers.get("content-type")?.startsWith("application/json")
          ? await response.json()
          : response.body;
      await next();
    }
  },
).get("/modrinth/v2/project/:id", async (ctx) => {
  console.time(`modrinth-project:${ctx.params.id}`);
  const body = ctx.response.body as ModrinthResponseBody;
  const langs = ctx.request.acceptsLanguages();
  if (!langs) {
    return ctx.throw(Status.BadRequest, "No language specified");
  }

  const lang = langs[0];
  const db = await ctx.state.getDatabase();
  const coll = db.collection("translated");
  if (lang !== "*" && !lang.startsWith("en")) {
    const summaryResult = await getOrTranslate(
      ctx.params.id,
      lang,
      body.description,
      body.slug,
      "summary",
      "modrinth",
      "",
      coll,
    );
    const descriptionResult = await getOrTranslate(
      ctx.params.id,
      lang,
      body.body,
      body.slug,
      "description",
      "modrinth",
      "markdown",
      coll,
    );

    if (typeof summaryResult === "object") {
      return ctx.throw(
        Status.InternalServerError,
        summaryResult.error.message,
        summaryResult.error,
      );
    }
    if (typeof descriptionResult === "object") {
      return ctx.throw(
        Status.InternalServerError,
        descriptionResult.error.message,
        descriptionResult.error,
      );
    }

    body.description = summaryResult;
    body.body = descriptionResult;

    ctx.response.body = body;
    ctx.response.headers.set("content-language", lang);
    console.timeLog(`modrinth-project:${ctx.params.id}`);
  } else {
    await Promise.all([
      ensureSourceLocale(
        ctx.params.id,
        "summary",
        "modrinth",
        body.description,
        body.slug,
        coll,
      )
        .catch(() => { }),
      ensureSourceLocale(
        ctx.params.id,
        "description",
        "modrinth",
        body.body,
        body.slug,
        coll,
      )
        .catch(() => { }),
    ]);
  }
});
