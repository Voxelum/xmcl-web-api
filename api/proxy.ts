import { defineApi } from "../type.ts";

import {
  minecraftAuthMiddleware,
  MinecraftAuthState,
} from "../middlewares/minecraftAuth.ts";
import { chat, ModrinthResponseBody } from "../utils/chatgpt.ts";
import { splitHTMLChildrenLargerThan4000ByTag } from "../utils/html.ts";
import {
  placeholderAllUrlInMarkdown,
  restoreAllUrlInMarkdown,
  splitMarkdownIfLengthLargerThan4000,
} from "../utils/markdown.ts";
import {
  composeMiddleware,
  Router,
  Status,
} from "https://deno.land/x/oak@v11.1.0/mod.ts";
import {
  Collection,
  Database,
  Document,
} from "https://deno.land/x/mongo@v0.31.1/mod.ts";
import { MongoDbState } from "../middlewares/mongoDb.ts";
import { mongoDbMiddleware } from "../middlewares/mongoDb.ts";

const sha1 = async (str: string) => {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest("SHA-1", data);
  const hashHex = Array.from(new Uint16Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return hashHex;
};
const systemPrompt = {
  role: "system",
  content:
    "You are an asistant of a Minecraft mod developer. You are asked to translate the mod description into different languages by locale code.",
};
const translate = async (
  id: string,
  locale: string,
  text: string,
  slug: string,
  type: string,
  domain: string,
  textType: "markdown" | "html" | "raw",
  coll: Collection<Document>,
) => {
  const _id = await sha1(text + locale);
  const founed = await coll.findOne({
    _id: {
      $eq: _id,
    },
  });
  if (founed) {
    return founed.content as string;
  }

  const process = async (t: string) => {
    const resp = await chat([systemPrompt, {
      role: "user",
      content:
        `Translate following ${textType} text into ${locale} ${textType} text:\n${t}`,
    }]);
    if ("error" in resp) {
      return resp;
    }
    return resp.choices[0].message.content;
  };

  let result = "";
  if (textType === "markdown") {
    const holder = [] as string[];
    const transformed = placeholderAllUrlInMarkdown(text, holder);
    const chunks = splitMarkdownIfLengthLargerThan4000(transformed);
    const outputs = await Promise.all(chunks.map(process));
    const err = outputs.find((o) => typeof o === "object");
    if (err) return err;
    result = restoreAllUrlInMarkdown(outputs.join(""), holder);
  } else if (textType === "html") {
    const chunks = splitHTMLChildrenLargerThan4000ByTag(text);
    const outputs = await Promise.all(chunks.map(process));
    const err = outputs.find((o) => typeof o === "object");
    if (err) return err;
    result = outputs.join("");
  } else {
    const translated = await process(text);
    if (typeof translated === "object") return translated;
    result = translated;
  }

  await coll.insertOne({
    _id,
    id,
    content: result,
    locale,
    slug,
    domain,
    type,
  });

  return result;
};

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

export default defineApi(
  (router: Router<{ getDatabase(): Promise<Database> }>) => {
    router.get(
      "/curseforge/(.*)",
      composeMiddleware<MinecraftAuthState & MongoDbState>([
        minecraftAuthMiddleware,
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
              ? ctx.request.body({ type: "stream" }).value
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
        const summary = await translate(
          ctx.params.modId,
          lang,
          body.data.summary,
          body.data.slug,
          "summary",
          "curseforge",
          "raw",
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
        ).catch(() => {});
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
        const description = await translate(
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
          .catch(() => {});
      }
    }).get(
      "/modrinth/(.*)",
      composeMiddleware<MinecraftAuthState & MongoDbState>([
        minecraftAuthMiddleware,
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
              ? ctx.request.body({ type: "stream" }).value
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
      const body = ctx.response.body as ModrinthResponseBody;
      const langs = ctx.request.acceptsLanguages();
      if (!langs) {
        return ctx.throw(Status.BadRequest, "No language specified");
      }

      const lang = langs[0];
      const db = await ctx.state.getDatabase();
      const coll = db.collection("translated");
      if (lang !== "*" && !lang.startsWith("en")) {
        const summaryResult = await translate(
          ctx.params.id,
          lang,
          body.description,
          body.slug,
          "summary",
          "modrinth",
          "raw",
          coll,
        );
        const descriptionResult = await translate(
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
            .catch(() => {}),
          ensureSourceLocale(
            ctx.params.id,
            "description",
            "modrinth",
            body.body,
            body.slug,
            coll,
          )
            .catch(() => {}),
        ]);
      }
    });
  },
);
