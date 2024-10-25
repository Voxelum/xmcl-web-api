import { Middleware } from "oak";
import { translate } from "../utils/translation.ts";
import { getDatabase } from "./mongoDb.ts";

export interface WithKv {
  kv: Deno.Kv;
}

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

    if (!founed) {
      return
    }

    console.time(`translate:${id}:${contentType}`);
    const result = await translate(lang, body, contentType)
    console.timeLog(`translate:${id}:${contentType}`);
    
    await coll.insertOne({
      _id,
      id,
      content: result,
      locale: lang,
      contentType,
      type,
    });
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
