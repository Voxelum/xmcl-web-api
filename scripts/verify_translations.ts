import { MongoClient } from "mongo";
const client = new MongoClient();
await client.connect(Deno.env.get("MONGO_CONNECION_STRING")!);
const db = client.database(Deno.env.get("MONGODB_NAME") || "coturn");
for (
  const name of (await db.listCollectionNames()).filter((n) =>
    n.endsWith("_translation")
  )
) {
  const locale = name.slice(0, -"_translation".length);
  const count = await db.collection(name).countDocuments();
  let files = 0;
  try {
    for await (const e of Deno.readDir(`translations/${locale}`)) {
      if (e.isFile && e.name.endsWith(".json")) files++;
    }
  } catch { /* no dir */ }
  console.log(
    `${locale}: files=${files} db=${count} ${
      files >= count ? "OK" : "SHORT by " + (count - files)
    }`,
  );
}
await client.close();
