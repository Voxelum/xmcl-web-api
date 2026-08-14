import assert from "node:assert/strict";
import { runtimeEnvironmentError } from "./runtimeEnvironment.ts";

Deno.test("staging requires isolated data and test payments", () => {
  assert.equal(
    runtimeEnvironmentError({
      XMCL_DEPLOYMENT_ENVIRONMENT: "staging",
      MONGODB_NAME: "coturn_staging",
      WAFFO_ENVIRONMENT: "test",
      XMCL_OAUTH_REDIRECT_URIS:
        "https://staging.xmcl-page.pages.dev/oauth/callback",
    }, "staging"),
    undefined,
  );
  assert.equal(
    runtimeEnvironmentError({
      XMCL_DEPLOYMENT_ENVIRONMENT: "staging",
      MONGODB_NAME: "coturn",
      WAFFO_ENVIRONMENT: "test",
    }, "staging"),
    "staging_database_required",
  );
  assert.equal(
    runtimeEnvironmentError({
      XMCL_DEPLOYMENT_ENVIRONMENT: "staging",
      MONGODB_NAME: "coturn_staging",
      WAFFO_ENVIRONMENT: "prod",
    }, "staging"),
    "staging_payment_environment_required",
  );
});

Deno.test("production rejects staging data, test payments, and staging redirects", () => {
  assert.equal(
    runtimeEnvironmentError({
      XMCL_DEPLOYMENT_ENVIRONMENT: "production",
      XMCL_HOME_RELEASE_ENABLED: "true",
      MONGODB_NAME: "coturn",
      WAFFO_ENVIRONMENT: "prod",
      XMCL_OAUTH_REDIRECT_URIS: "https://xmcl.app/oauth/callback",
    }, "production"),
    undefined,
  );
  assert.equal(
    runtimeEnvironmentError({
      XMCL_DEPLOYMENT_ENVIRONMENT: "production",
      XMCL_HOME_RELEASE_ENABLED: "true",
      MONGODB_NAME: "coturn_staging",
      WAFFO_ENVIRONMENT: "prod",
    }, "production"),
    "production_database_required",
  );
  assert.equal(
    runtimeEnvironmentError({
      XMCL_DEPLOYMENT_ENVIRONMENT: "production",
      XMCL_HOME_RELEASE_ENABLED: "true",
      MONGODB_NAME: "coturn",
      WAFFO_ENVIRONMENT: "test",
    }, "production"),
    "production_payment_environment_required",
  );
  assert.equal(
    runtimeEnvironmentError({
      XMCL_DEPLOYMENT_ENVIRONMENT: "production",
      XMCL_HOME_RELEASE_ENABLED: "true",
      MONGODB_NAME: "coturn",
      WAFFO_ENVIRONMENT: "prod",
      XMCL_OAUTH_REDIRECT_URIS:
        "https://staging.xmcl-page.pages.dev/oauth/callback",
    }, "production"),
    "production_oauth_redirect_required",
  );
  assert.equal(
    runtimeEnvironmentError({
      XMCL_DEPLOYMENT_ENVIRONMENT: "production",
      XMCL_HOME_RELEASE_ENABLED: "false",
      MONGODB_NAME: "coturn",
    }, "production"),
    undefined,
  );
  assert.equal(
    runtimeEnvironmentError({
      XMCL_DEPLOYMENT_ENVIRONMENT: "production",
      XMCL_HOME_RELEASE_ENABLED: "false",
      MONGODB_NAME: "coturn",
      WAFFO_ENVIRONMENT: "test",
    }, "production"),
    "production_payment_environment_required",
  );
});
