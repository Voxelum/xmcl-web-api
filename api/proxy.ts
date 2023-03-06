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
import { Database } from "https://deno.land/x/mongo@v0.31.1/mod.ts";
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

export default defineApi(
  (router: Router<{ getDatabase(): Promise<Database> }>) => {
    const systemPrompt = {
      role: "system",
      content:
        "You are an asistant of a Minecraft mod developer. You are asked to translate the mod description into Chinese.",
    };
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
      const body = ctx.response.body as { data: { summary: string } };

      const db = await ctx.state.getDatabase();
      const coll = db.collection("translated");

      const process = async (t: string) => {
        const id = await sha1(t);
        const founed = await coll.findOne({ _id: id });
        if (founed) {
          return founed.content as string;
        }
        const resp = await chat([systemPrompt, {
          role: "user",
          content: `Translate following text into Chinese:\n${t}`,
        }]);
        if ("error" in resp) {
          return ctx.throw(
            Status.InternalServerError,
            resp.error.message,
            resp.error,
          );
        }
        const result = resp.choices[0].message.content;

        await coll.insertOne({
          _id: id,
          content: result,
          modId: ctx.params.modId,
          domain: "curseforge",
          type: "description",
        });
        return result;
      };

      body.data.summary = await process(body.data.summary);
      ctx.response.body = body;
    }).get("/curseforge/v1/mods/:modId/description", async (ctx) => {
      const body = ctx.response.body as { data: string };

      const db = await ctx.state.getDatabase();
      const coll = db.collection("translated");

      const process = async (d: string) => {
        const id = await sha1(d);
        const founed = await coll.findOne({ _id: id });
        if (founed) {
          return founed.content as string;
        }
        const parts = splitHTMLChildrenLargerThan4000ByTag(d);
        const outputs = await Promise.all(parts.map(async (p) => {
          const resp = await chat([systemPrompt, {
            role: "user",
            content:
              `Translate following HTML text into Chinese HTML text:\n${p}`,
          }]);
          if ("error" in resp) {
            return ctx.throw(
              Status.InternalServerError,
              resp.error.message,
              resp.error,
            );
          }
          return resp.choices[0].message.content;
        }));

        const result = outputs.join("");
        await coll.insertOne({
          _id: id,
          content: result,
          modId: ctx.params.modId,
          domain: "curseforge",
          type: "description",
        });
        return result;
      };
      body.data = await process(body.data);
      ctx.response.body = body;
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

      const db = await ctx.state.getDatabase();
      const coll = db.collection("translated");

      const processDescription = async () => {
        const description = body.description;
        const id = await sha1(description);
        const founed = await coll.findOne({
          _id: {
            $eq: id,
          },
        });
        if (founed) return founed.content as string;

        const resp = await chat([systemPrompt, {
          role: "user",
          content: `Translate following text into Chinese:\n${description}`,
        }]);
        if ("error" in resp) {
          return ctx.throw(
            Status.InternalServerError,
            resp.error.message,
            resp.error,
          );
        }
        const result = resp.choices[0].message.content;

        await coll.insertOne({
          _id: id,
          content: result,
          modId: ctx.params.id,
          domain: "modrinth",
          type: "summary",
        });
        return result;
      };
      const processBody = async () => {
        const bodyText = body.body;
        const id = await sha1(bodyText);
        const founed = await coll.findOne({
          _id: {
            $eq: id,
          },
        });
        if (founed) return founed.content as string;
        const holder = [] as string[];
        const transformed = placeholderAllUrlInMarkdown(bodyText, holder);
        const chunks = splitMarkdownIfLengthLargerThan4000(transformed);

        const outputs = await Promise.all(chunks.map(async (c) => {
          const messages = [{
            role: "system",
            content:
              "You are an asistant of a Minecraft mod developer. You are asked to translate the mod description into Chinese.",
          }, {
            role: "user",
            content:
              `Translate following markdown text into Chinese markdown text:\n${c}`,
          }];
          const resp = await chat(messages);
          if ("error" in resp) {
            return ctx.throw(
              Status.InternalServerError,
              resp.error.message,
              resp.error,
            );
          }
          const content = resp.choices[0].message.content;
          return content;
        }));
        const message = outputs.join("\n");
        const restored = restoreAllUrlInMarkdown(message, holder);

        await coll.insertOne({
          _id: id,
          content: restored,
          modId: ctx.params.id,
          domain: "modrinth",
          type: "description",
        });

        return restored;
      };

      const [summary, description] = await Promise.all([
        processDescription(),
        processBody(),
      ]);

      body.description = summary;
      body.body = description;

      ctx.response.body = body;
    });
  },
);
