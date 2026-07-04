// deno-lint-ignore-file no-explicit-any
import type { AppConfig } from "../config.ts";
import { getDb } from "../db.ts";
import { runTranslation, type TranslationJob } from "../translation_service.ts";

/**
 * Deno.Kv-backed async translation.
 *
 * Registers a queue listener that translates jobs (guarded by a per-(lang,id)
 * semaphore) and returns an `enqueue` function used by the `/translation`
 * route. Falls back to inline translation if enqueue fails.
 */
let kvPromise: Promise<any> | undefined;

export function setupDenoTranslation(config: AppConfig): {
  enqueue: (job: TranslationJob) => Promise<boolean>;
} {
  if (!kvPromise) {
    kvPromise = (Deno as any).openKv().then((kv: any) => {
      kv.listenQueue(async (job: TranslationJob) => {
        const db = await getDb(config);
        const coll = db.collection(`${job.lang}_translation`);
        const found = await coll.findOne({ _id: { $eq: job.id } });
        if (found && found.bodyHash === job.bodyHash) return;

        const semaphore = await kv.get(["translate", job.lang, job.id]);
        if (semaphore.value) return;

        const lock = await kv.atomic()
          .check({ key: semaphore.key, versionstamp: semaphore.versionstamp })
          .set(semaphore.key, 1)
          .commit();
        if (!lock.ok) return;

        try {
          const result = await runTranslation(db, job, {
            agnes: config.AGNES_API_KEY,
          });
          if (typeof result === "object") {
            console.error("Failed to translate", result.error);
          }
        } finally {
          await kv.delete(semaphore.key).catch((e: unknown) =>
            console.error("Failed to delete translation semaphore", e)
          );
        }
      });
      return kv;
    });
  }

  return {
    enqueue: async (job: TranslationJob) => {
      try {
        const kv = await kvPromise!;
        const res = await kv.enqueue(job);
        return Boolean(res?.ok);
      } catch (e) {
        console.error("Failed to enqueue translation", e);
        return false;
      }
    },
  };
}
