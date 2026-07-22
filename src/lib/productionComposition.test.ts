import assert from "node:assert/strict";
import {
  CommercialCompositionConfigurationError,
  createProductionApp,
  productionAppOptions,
} from "./productionComposition.ts";

Deno.test("production composition leaves commercial routes unmounted by default", () => {
  const app = createProductionApp({});
  const paths = app.routes.map((route) => route.path);
  assert.equal(paths.some((path) => path.startsWith("/v1/ai")), false);
  assert.equal(paths.some((path) => path.startsWith("/v1/modpack")), false);
  assert.equal(paths.some((path) => path.startsWith("/v1/sessions")), true);
});

Deno.test("production composition fails clearly when commercial routes are enabled", () => {
  assert.throws(
    () => productionAppOptions({ XMCL_COMMERCIAL_ENABLED: "true" }),
    CommercialCompositionConfigurationError,
  );
});
