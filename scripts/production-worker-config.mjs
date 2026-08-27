import { stdin, stdout } from "node:process";

const REQUIRED_WAFFO_SETTINGS = [
  "WAFFO_STORE_ID",
  "WAFFO_ENVIRONMENT",
];
const OPTIONAL_WAFFO_SETTINGS = ["WAFFO_PRODUCT_ID"];
const PRODUCTION_DATABASE_NAME = "coturn";

export const REQUIRED_DATABASE_BINDINGS = [
  "MONGO_CONNECION_STRING",
  "MONGODB_NAME",
];

export const REQUIRED_API_BINDINGS = [
  ...REQUIRED_DATABASE_BINDINGS,
  "XMCL_MULTIPLAYER_TICKET_SECRET",
  "XMCL_SESSION_SECRET_PRIMARY",
  "BILLING_CURRENCY",
  "BILLING_RATES_JSON",
  "WAFFO_MERCHANT_ID",
  "WAFFO_PRIVATE_KEY",
  ...REQUIRED_WAFFO_SETTINGS,
];

export const REQUIRED_AI_BINDINGS = [
  ...REQUIRED_DATABASE_BINDINGS,
  "XMCL_SESSION_SECRET_PRIMARY",
];

export const REQUIRED_SIGNALING_BINDINGS = [
  ...REQUIRED_DATABASE_BINDINGS,
  "CLOUDFLARE_ANALYTICS_API_TOKEN",
  "CLOUDFLARE_APP_ID",
  "XMCL_MULTIPLAYER_TICKET_SECRET",
  "XMCL_SESSION_SECRET_PRIMARY",
];

function requiredValue(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function productionDatabaseConfig(environment) {
  const databaseName = requiredValue(environment, "MONGODB_NAME");
  if (databaseName !== PRODUCTION_DATABASE_NAME) {
    throw new Error(
      `production MONGODB_NAME must be ${PRODUCTION_DATABASE_NAME}`,
    );
  }
  return { MONGODB_NAME: databaseName };
}

export function productionWorkerConfig(environment) {
  const database = productionDatabaseConfig(environment);
  const currency = requiredValue(environment, "BILLING_CURRENCY");
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error("BILLING_CURRENCY must be an ISO-4217 currency code");
  }

  const ratesValue = requiredValue(environment, "BILLING_RATES_JSON");
  let rates;
  try {
    rates = JSON.parse(ratesValue);
  } catch {
    throw new Error("BILLING_RATES_JSON must be valid JSON");
  }
  if (!Array.isArray(rates)) {
    throw new Error("BILLING_RATES_JSON must be a JSON array");
  }

  const config = {
    ...database,
    BILLING_CURRENCY: currency,
    BILLING_RATES_JSON: JSON.stringify(rates),
  };
  const allWaffoSettings = [
    ...REQUIRED_WAFFO_SETTINGS,
    ...OPTIONAL_WAFFO_SETTINGS,
  ];
  const configuredWaffoSettings = allWaffoSettings.filter((name) =>
    environment[name]?.trim()
  );
  if (configuredWaffoSettings.length !== 0) {
    const missing = REQUIRED_WAFFO_SETTINGS.filter((name) =>
      !environment[name]?.trim()
    );
    if (missing.length > 0) {
      throw new Error(
        `Waffo production configuration is incomplete; missing ${
          missing.join(", ")
        }`,
      );
    }
    const waffoEnvironment = environment.WAFFO_ENVIRONMENT.trim();
    if (waffoEnvironment !== "test" && waffoEnvironment !== "prod") {
      throw new Error("WAFFO_ENVIRONMENT must be test or prod");
    }
    for (const name of REQUIRED_WAFFO_SETTINGS) {
      config[name] = environment[name].trim();
    }
    for (const name of OPTIONAL_WAFFO_SETTINGS) {
      if (environment[name]?.trim()) config[name] = environment[name].trim();
    }
  }
  return config;
}

export function validateApiBindingNames(bindings) {
  validateBindingNames(bindings, REQUIRED_API_BINDINGS, "API");
}

export function validateWorkerBindingNames(bindings, surface) {
  const requirements = {
    api: REQUIRED_API_BINDINGS,
    ai: REQUIRED_AI_BINDINGS,
    signaling: REQUIRED_SIGNALING_BINDINGS,
  };
  const required = requirements[surface];
  if (!required) throw new Error(`Unknown Worker surface: ${surface}`);
  validateBindingNames(bindings, required, surface);
}

function validateBindingNames(bindings, required, surface) {
  const names = new Set(bindings.map((binding) => binding.name));
  const missing = required.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(
      `deployed ${surface} Worker is missing required bindings: ${
        missing.join(", ")
      }`,
    );
  }
}

async function readStdin() {
  let value = "";
  stdin.setEncoding("utf8");
  for await (const chunk of stdin) value += chunk;
  return value;
}

async function main() {
  if (process.argv.includes("--validate-bindings")) {
    const bindings = JSON.parse(await readStdin());
    if (!Array.isArray(bindings)) {
      throw new Error("Wrangler binding output must be a JSON array");
    }
    const surface = process.argv.find((value) => value.startsWith("--surface="))
      ?.slice("--surface=".length) ?? "api";
    validateWorkerBindingNames(bindings, surface);
    return;
  }
  const config = process.argv.includes("--database-only")
    ? productionDatabaseConfig(process.env)
    : productionWorkerConfig(process.env);
  stdout.write(`${JSON.stringify(config)}\n`);
}

if (process.argv[1]?.endsWith("production-worker-config.mjs")) {
  main().catch((error) => {
    console.error(`Production Worker configuration failed: ${error.message}`);
    process.exitCode = 1;
  });
}
