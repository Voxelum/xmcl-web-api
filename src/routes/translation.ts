import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { getConfig } from "../config.ts";
import { getHasher } from "../lib/hasher.ts";
import { dbMiddleware } from "../middleware/db.ts";
import { forwardHeaders } from "../proxy.ts";
import { runTranslation, type TranslationJob } from "../translation_service.ts";
import type { AppEnv } from "../types.ts";

interface ModrinthResponseBody {
  body: string;
}

function firstLanguage(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const first = header.split(",")[0]?.split(";")[0]?.trim();
  return first || undefined;
}

export default new Hono<AppEnv>().get("/translation", dbMiddleware, async (c) => {
  const config = getConfig(c);

  const type = c.req.query("type");
  if (!type) throw new HTTPException(400, { message: "No type specified" });
  if (type !== "modrinth" && type !== "curseforge") {
    throw new HTTPException(400, { message: "Invalid type" });
  }

  const id = c.req.query("id");
  if (!id) throw new HTTPException(400, { message: "No id specified" });

  const lang = firstLanguage(c.req.header("Accept-Language"));
  if (!lang) throw new HTTPException(400, { message: "No language specified" });

  const getCurseforgeDescription = async (modId: string) => {
    const headers = forwardHeaders(c.req.raw);
    headers.set("x-api-key", config.CURSEFORGE_KEY ?? "");
    const response = await fetch(
      `https://api.curseforge.com/v1/mods/${modId}/description`,
      { headers },
    );
    if (!response.ok) {
      throw new HTTPException(response.status as 400, { message: await response.text() });
    }
    return ((await response.json()) as { data: string }).data;
  };

  const getModrinthDescription = async (projectId: string) => {
    const response = await fetch(
      `https://api.modrinth.com/v2/project/${projectId}`,
      { headers: forwardHeaders(c.req.raw) },
    );
    if (!response.ok) {
      throw new HTTPException(response.status as 400, { message: await response.text() });
    }
    return ((await response.json()) as ModrinthResponseBody).body;
  };

  const db = await c.var.getDb();
  const body = type === "curseforge"
    ? await getCurseforgeDescription(id)
    : await getModrinthDescription(id);
  const contentType: "text/html" | "text/markdown" =
    type === "curseforge" ? "text/html" : "text/markdown";

  // English content needs no translation.
  if (lang === "*" || lang.startsWith("en")) {
    return c.body(null, 204);
  }

  const hash = await getHasher();
  const bodyHash = hash(body);
  const newColl = db.collection(`${lang}_translation`);

  const respond = (content: string) =>
    c.body(content, 200, {
      "content-language": lang,
      "content-type": contentType,
      "cache-control": "public, max-age=86400",
    });

  // New cache: keyed by project id in `<locale>_translation`, validated by hash.
  const newFound = await newColl.findOne({ _id: { $eq: id } });
  if (newFound && newFound.bodyHash === bodyHash) {
    return respond(newFound.content);
  }

  // Legacy cache: keyed by hash(body + lang) in `translated`; migrate on hit.
  if (!newFound) {
    const legacyId = hash(body + lang);
    const legacyColl = db.collection("translated");
    const legacyFound = await legacyColl.findOne({ _id: { $eq: legacyId } });
    if (legacyFound) {
      await newColl.replaceOne(
        { _id: id },
        { _id: id, bodyHash, content: legacyFound.content, contentType, type },
        { upsert: true },
      );
      await legacyColl.deleteOne({ _id: legacyId });
      return respond(legacyFound.content);
    }
  }

  const job: TranslationJob = { lang, body, bodyHash, contentType, type, id };

  // Offload to a queue when the platform provides one; otherwise translate now.
  const enqueued = c.var.enqueueTranslation
    ? await c.var.enqueueTranslation(job)
    : false;
  if (enqueued) {
    return c.body(null, 202);
  }

  const result = await runTranslation(db, job, {
    agnes: config.AGNES_API_KEY,
  });
  if (typeof result === "object") {
    throw new HTTPException(500, { message: result.error.message });
  }
  return respond(result);
});
