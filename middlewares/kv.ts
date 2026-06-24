import { Middleware } from "oak";
import { translate } from "../utils/translation.ts";
import { getDatabase } from "./mongoDb.ts";
import { translatev2 } from "../utils/translationv2.ts";

export interface WithKv {
  kv: Deno.Kv;
}

Deno.cron("check-db-status", "0 0 * * *", () => {
  Deno.openKv().then(async (kv) => {
    // get count
    let count = 0
    for await (const _ of kv.list({
      prefix: ["translate"],
    })) {
      count++
    }
    kv.set(["db-count"], count.toString())
  })
})

const promise = Deno.openKv().then((kv) => {
  kv.listenQueue(async ({ lang, body, bodyHash, contentType, type, id }: {
    lang: string,
    body: string,
    bodyHash: string,
    contentType: 'text/html' | 'text/markdown',
    type: string,
    id: string,
  }) => {
    const db = await getDatabase()
    const coll = db.collection(`${lang}_translation`);

    const founed = await coll.findOne({
      _id: {
        $eq: id,
      },
    });

    if (founed && founed.bodyHash === bodyHash) {
      return
    }

    const semaphore = await kv.get(['translate', lang, id])

    if (semaphore.value) {
      return
    }

    // up 1
    const lockResult = await kv.atomic()
      .check({ key: semaphore.key, versionstamp: semaphore.versionstamp })
      .set(semaphore.key, 1)
      .commit()

    if (!lockResult.ok) {
      return
    }

    try {
      console.time(`translate:${id}:${contentType}`);
      const result = lang === 'ru' ? await translatev2(lang, body, contentType) : await translate(lang, body, contentType)
      console.timeLog(`translate:${id}:${contentType}`);

      if (typeof result === "object") {
        console.error('Fail to translate', result.error)
        return
      }

      await coll.replaceOne(
        { _id: id },
        { _id: id, bodyHash, content: result, contentType, type },
        { upsert: true },
      );
    } finally {
      // delete semaphore
      kv.delete(semaphore.key).catch((e) => {
        console.error('Fail to delete translation semaphore', e)
      })
    }
  })
  return kv
})

export const kvMiddlware: Middleware<WithKv> = async (
  ctx,
  next,
) => {
  ctx.state.kv = await promise;
  await next();
};
