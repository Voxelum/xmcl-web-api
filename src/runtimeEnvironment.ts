import type { AppConfig } from "./config.ts";

export type DeploymentEnvironment = "staging" | "production";

export function runtimeEnvironmentError(
  config: Pick<
    AppConfig,
    | "MONGODB_NAME"
    | "WAFFO_ENVIRONMENT"
    | "XMCL_DEPLOYMENT_ENVIRONMENT"
    | "XMCL_HOME_RELEASE_ENABLED"
    | "XMCL_OAUTH_REDIRECT_URIS"
  >,
  expected: DeploymentEnvironment,
): string | undefined {
  if (config.XMCL_DEPLOYMENT_ENVIRONMENT !== expected) {
    return "deployment_environment_mismatch";
  }
  const databaseName = config.MONGODB_NAME?.trim().toLowerCase();
  if (!databaseName) return "mongodb_name_required";
  if (expected === "staging") {
    if (!databaseName.includes("staging")) return "staging_database_required";
    if (config.WAFFO_ENVIRONMENT !== "test") {
      return "staging_payment_environment_required";
    }
  } else {
    if (databaseName.includes("staging")) return "production_database_required";
    if (
      (config.XMCL_HOME_RELEASE_ENABLED === "true" ||
        config.WAFFO_ENVIRONMENT !== undefined) &&
      config.WAFFO_ENVIRONMENT !== "prod"
    ) {
      return "production_payment_environment_required";
    }
  }
  const redirects = (config.XMCL_OAUTH_REDIRECT_URIS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    expected === "production" &&
    redirects.some((value) => {
      try {
        return new URL(value).hostname.includes("staging");
      } catch {
        return true;
      }
    })
  ) {
    return "production_oauth_redirect_required";
  }
  return undefined;
}
