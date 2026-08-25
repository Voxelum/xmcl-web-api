import { stdin, stdout } from "node:process";

const REQUIRED_WAFFO_SETTINGS = [
  "WAFFO_STORE_ID",
  "WAFFO_ENVIRONMENT",
];
const OPTIONAL_WAFFO_SETTINGS = ["WAFFO_PRODUCT_ID"];

export const REQUIRED_API_BINDINGS = [
  "MONGO_CONNECION_STRING",
  "XMCL_MULTIPLAYER_TICKET_SECRET",
  "XMCL_SESSION_SECRET_PRIMARY",
  "BILLING_CURRENCY",
  "BILLING_RATES_JSON",
  "WAFFO_MERCHANT_ID",
  "WAFFO_PRIVATE_KEY",
  ...REQUIRED_WAFFO_SETTINGS,
];

function requiredValue(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function productionWorkerConfig(environment) {
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
  const names = new Set(bindings.map((binding) => binding.name));
  const missing = REQUIRED_API_BINDINGS.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(
      `deployed API Worker is missing required bindings: ${missing.join(", ")}`,
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
    validateApiBindingNames(bindings);
    return;
  }
  stdout.write(`${JSON.stringify(productionWorkerConfig(process.env))}\n`);
}

if (process.argv[1]?.endsWith("production-worker-config.mjs")) {
  main().catch((error) => {
    console.error(`Production Worker configuration failed: ${error.message}`);
    process.exitCode = 1;
  });
}
