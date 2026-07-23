import assert from "node:assert/strict";
import {
  createProductionApp,
  productionAppOptions,
} from "./productionComposition.ts";

Deno.test("production composition leaves commercial routes unmounted by default", () => {
  const app = createProductionApp();
  const paths = app.routes.map((route) => route.path);
  assert.equal(paths.some((path) => path.startsWith("/v1/ai")), false);
  assert.equal(paths.some((path) => path.startsWith("/v1/modpack")), false);
  assert.equal(paths.some((path) => path.startsWith("/v1/sessions")), true);
});

Deno.test("production composition always disables routes without durable adapters", () => {
  assert.deepEqual(productionAppOptions(), { commercialRoutes: false });
});
