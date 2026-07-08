import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { getConfig } from "../config.ts";
import { getHasher } from "../lib/hasher.ts";
import { forwardHeaders } from "../proxy.ts";
import { runTranslation, type TranslationJob } from "../translation_service.ts";
import type { AppEnv } from "../types.ts";

interface ModrinthResponseBody {
  body: string;
}

interface I18nEntry {
  bodyHash?: string;
  content?: string;
}

// In-memory circuit breaker for the community i18n CDN. When
// raw.githubusercontent rate-limits us (429, or a secondary 403), continuing to
// hit it just adds latency to every request and prolongs the limit, so we skip
// it until the cooldown expires and serve from the DB instead. This state is
// per worker instance (best-effort on serverless), which is all we need.
let i18nCooldownUntil = 0;

/**
 * Look up a translation from the community i18n CDN
 * (`<base>/<locale>/<id>.json`). Returns `undefined` on any miss, error,
 * timeout, or while rate-limited, so the caller falls through to the DB.
 */
async function fetchI18n(
  base: string,
  lang: string,
  id: string,
): Promise<I18nEntry | undefined> {
  if (Date.now() < i18nCooldownUntil) return undefined;

  let res: Response;
  try {
    res = await fetch(
      `${base}/${encodeURIComponent(lang)}/${encodeURIComponent(id)}.json`,
      { signal: AbortSignal.timeout(3000) },
    );
  } catch {
    return undefined; // network error / timeout -> fall through to DB
  }

  try {
    // Too Many Requests, or GitHub's secondary rate limit (403). Back off so we
    // stop hammering the CDN; honour Retry-After / rate-limit reset when given.
    if (res.status === 429 || res.status === 403) {
      const now = Date.now();
      const retryAfter = Number(res.headers.get("retry-after"));
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      let until = now + 60_000; // default 1 min
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        until = now + retryAfter * 1000;
      } else if (Number.isFinite(reset) && reset * 1000 > now) {
        until = reset * 1000;
      }
      // Never disable the CDN for more than 10 minutes on a single response.
      i18nCooldownUntil = Math.min(until, now + 600_000);
      return undefined;
    }

    if (!res.ok) return undefined;

    return await res.json() as I18nEntry;
  } catch {
    return undefined;
  } finally {
    // Ensure the body is drained so the connection can be reused.
    await res.body?.cancel().catch(() => {});
  }
}

function firstLanguage(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const first = header.split(",")[0]?.split(";")[0]?.trim();
  return first || undefined;
}

export default new Hono<AppEnv>().get("/translation", async (c) => {
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

  // English content needs no translation.
  if (lang === "*" || lang.startsWith("en")) {
    return c.body(null, 204);
  }

  // Telemetry: count requests per project to inform a future hot/cold DB split.
  // Runs concurrently with the description fetch and never breaks the response.
  const recordRequest = db
    .collection("translation_requests")
    .updateOne(
      { _id: `${type}:${id}` },
      {
        $inc: { count: 1, [`langs.${lang}`]: 1 },
        $set: { type, projectId: id, lastAccess: new Date() },
      },
      { upsert: true },
    )
    .catch(() => {});

  const [body] = await Promise.all([
    type === "curseforge"
      ? getCurseforgeDescription(id)
      : getModrinthDescription(id),
    recordRequest,
  ]);
  const contentType: "text/html" | "text/markdown" =
    type === "curseforge" ? "text/html" : "text/markdown";

  const hash = await getHasher();
  const bodyHash = hash(body);
  const newColl = db.collection(`${lang}_translation`);

  const respond = (content: string) =>
    c.body(content, 200, {
      "content-language": lang,
      "content-type": contentType,
      "cache-control": "public, max-age=86400",
    });

  // Community i18n repo (served as raw files) is the cheapest source: a plain
  // CDN GET, no DB round-trip. Layout is `<base>/<locale>/<id>.json` and each
  // file mirrors the cached document, validated by `bodyHash` so a stale
  // translation (source text changed) falls through to the DB / a fresh run.
  const i18nBase = (config.TRANSLATION_I18N_BASE ??
    "https://raw.githubusercontent.com/Voxelum/xmcl-community-content-i18n-extra/main")
    .replace(/\/+$/, "");
  const githubFound = await fetchI18n(i18nBase, lang, id);
  if (
    githubFound && githubFound.bodyHash === bodyHash &&
    typeof githubFound.content === "string"
  ) {
    return respond(githubFound.content);
  }

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
