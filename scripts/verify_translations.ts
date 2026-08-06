import { MongoClient } from "mongodb";
const client = new MongoClient(Deno.env.get("MONGO_CONNECION_STRING")!);
await client.connect();
const db = client.db(Deno.env.get("MONGODB_NAME") || "coturn");
for (
  const name of (await db.listCollections({}, { nameOnly: true }).toArray())
    .map(({ name }) => name)
    .filter((name) => name.endsWith("_translation"))
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
