import assert from "node:assert/strict";
import test from "node:test";
import {
  productionWorkerConfig,
  REQUIRED_API_BINDINGS,
  validateApiBindingNames,
} from "./production-worker-config.mjs";

test("normalizes required billing configuration", () => {
  assert.deepEqual(
    productionWorkerConfig({
      BILLING_CURRENCY: "USD",
      BILLING_RATES_JSON: " [ ] ",
    }),
    {
      BILLING_CURRENCY: "USD",
      BILLING_RATES_JSON: "[]",
    },
  );
});

test("rejects missing or malformed billing configuration", () => {
  assert.throws(
    () => productionWorkerConfig({ BILLING_RATES_JSON: "[]" }),
    /BILLING_CURRENCY is required/,
  );
  assert.throws(
    () =>
      productionWorkerConfig({
        BILLING_CURRENCY: "usd",
        BILLING_RATES_JSON: "[]",
      }),
    /ISO-4217/,
  );
  assert.throws(
    () =>
      productionWorkerConfig({
        BILLING_CURRENCY: "USD",
        BILLING_RATES_JSON: "{}",
      }),
    /must be a JSON array/,
  );
});

test("requires the Waffo store and environment together", () => {
  const billing = {
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
});
