import type { Db } from "./db.ts";
import { translate } from "./lib/translation.ts";

export interface TranslationJob {
  lang: string;
  body: string;
  bodyHash: string;
  contentType: "text/html" | "text/markdown";
  type: string;
  id: string;
}

export interface TranslationKeys {
  agnes?: string;
}

interface ChatError {
  error: { message: string; code?: string; type?: string };
}

/**
 * Translate a job and persist the result into `${lang}_translation`.
 *
 * Shared by the synchronous path in the `/translation` route and the async
 * consumers (Deno.Kv queue / Cloudflare Queue) so behaviour is identical
 * regardless of how the work is scheduled.
 *
 * Returns the translated content, or a `ChatError` if the LLM call failed.
 */
export async function runTranslation(
  db: Db,
  job: TranslationJob,
  keys: TranslationKeys,
): Promise<string | ChatError> {
  const result = await translate(job.lang, job.body, job.contentType, keys.agnes);

  if (typeof result === "object") {
    return result as ChatError;
  }

  const coll = db.collection(`${job.lang}_translation`);
  await coll.replaceOne(
    { _id: job.id },
    {
      _id: job.id,
      bodyHash: job.bodyHash,
      content: result,
      contentType: job.contentType,
      type: job.type,
    },
    { upsert: true },
  );

  return result;
}
