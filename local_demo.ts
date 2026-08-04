import { createLocalDemoApp, LOCAL_DEMO_PROFILE } from "./src/localDemo.ts";

function portFromEnvironment() {
  const value = Deno.env.get("PORT") ?? "8787";
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

const port = portFromEnvironment();
const { app } = await createLocalDemoApp();

console.log(
  `${LOCAL_DEMO_PROFILE} is listening on http://127.0.0.1:${port}\n` +
    "This process uses only in-memory/mock adapters. Stop it to discard demo data.",
);

Deno.serve({ hostname: "127.0.0.1", port }, app.fetch);
