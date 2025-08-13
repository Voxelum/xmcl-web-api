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
  kv.listenQueue(async ({ hash: _id, lang, body, contentType, type, id }: {
    hash: string,
    lang: string,
    body: string,
    contentType: 'text/html' | 'text/markdown',
    type: string,
    id: string,
  }) => {
    const db = await getDatabase()
    const coll = db.collection("translated");

    const founed = await coll.findOne({
      _id: {
        $eq: _id,
      },
    });

    if (founed) {
      return
    }

    const semaphore = await kv.get(['translate', _id])

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

      await coll.insertOne({
        _id,
        id,
        content: result,
        locale: lang,
        contentType,
        type,
      });
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
