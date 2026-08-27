import assert from "node:assert/strict";
import test from "node:test";
import {
  productionDatabaseConfig,
  productionWorkerConfig,
  REQUIRED_AI_BINDINGS,
  REQUIRED_API_BINDINGS,
  REQUIRED_SIGNALING_BINDINGS,
  validateApiBindingNames,
  validateWorkerBindingNames,
} from "./production-worker-config.mjs";

test("normalizes required billing configuration", () => {
  assert.deepEqual(
    productionWorkerConfig({
      MONGODB_NAME: "coturn",
      BILLING_CURRENCY: "USD",
      BILLING_RATES_JSON: " [ ] ",
    }),
    {
      MONGODB_NAME: "coturn",
      BILLING_CURRENCY: "USD",
      BILLING_RATES_JSON: "[]",
    },
  );
});

test("requires the production database for every Worker", () => {
  assert.deepEqual(
    productionDatabaseConfig({ MONGODB_NAME: " coturn " }),
    { MONGODB_NAME: "coturn" },
  );
  assert.throws(
    () => productionDatabaseConfig({}),
    /MONGODB_NAME is required/,
  );
  assert.throws(
    () => productionDatabaseConfig({ MONGODB_NAME: "coturn_staging" }),
    /must be coturn/,
  );
});

test("rejects missing or malformed billing configuration", () => {
  assert.throws(
    () =>
      productionWorkerConfig({
        MONGODB_NAME: "coturn",
        BILLING_RATES_JSON: "[]",
      }),
    /BILLING_CURRENCY is required/,
  );
  assert.throws(
    () =>
      productionWorkerConfig({
        MONGODB_NAME: "coturn",
        BILLING_CURRENCY: "usd",
        BILLING_RATES_JSON: "[]",
      }),
    /ISO-4217/,
  );
  assert.throws(
    () =>
      productionWorkerConfig({
        MONGODB_NAME: "coturn",
        BILLING_CURRENCY: "USD",
        BILLING_RATES_JSON: "{}",
      }),
    /must be a JSON array/,
  );
});

test("requires the Waffo store and environment together", () => {
  const billing = {
    MONGODB_NAME: "coturn",
    BILLING_CURRENCY: "USD",
    BILLING_RATES_JSON: "[]",
  };
  assert.throws(
    () =>
      productionWorkerConfig({
        ...billing,
        WAFFO_STORE_ID: "store",
      }),
    /WAFFO_ENVIRONMENT/,
  );
  assert.deepEqual(
    productionWorkerConfig({
      ...billing,
      WAFFO_STORE_ID: "store",
      WAFFO_ENVIRONMENT: "prod",
    }),
    {
      ...billing,
      WAFFO_STORE_ID: "store",
      WAFFO_ENVIRONMENT: "prod",
    },
  );
  assert.deepEqual(
    productionWorkerConfig({
      ...billing,
      WAFFO_STORE_ID: "store",
      WAFFO_PRODUCT_ID: "product",
      WAFFO_ENVIRONMENT: "prod",
    }),
    {
      ...billing,
      WAFFO_STORE_ID: "store",
      WAFFO_PRODUCT_ID: "product",
      WAFFO_ENVIRONMENT: "prod",
    },
  );
});

test("verifies required bindings after synchronization", () => {
  const bindings = REQUIRED_API_BINDINGS.map((name) => ({ name }));
  assert.doesNotThrow(() => validateApiBindingNames(bindings));
  assert.throws(
    () => validateApiBindingNames(bindings.slice(1)),
    /MONGO_CONNECION_STRING/,
  );

  assert.doesNotThrow(() =>
    validateWorkerBindingNames(
      REQUIRED_AI_BINDINGS.map((name) => ({ name })),
      "ai",
    )
  );
  assert.doesNotThrow(() =>
    validateWorkerBindingNames(
      REQUIRED_SIGNALING_BINDINGS.map((name) => ({ name })),
      "signaling",
    )
  );
  assert.throws(
    () =>
      validateWorkerBindingNames(
        REQUIRED_SIGNALING_BINDINGS
          .filter((name) => name !== "CLOUDFLARE_ANALYTICS_API_TOKEN")
          .map((name) => ({ name })),
        "signaling",
      ),
    /CLOUDFLARE_ANALYTICS_API_TOKEN/,
  );
});
