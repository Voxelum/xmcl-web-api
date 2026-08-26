import process from "node:process";
import { createAzureBlobSasSigner } from "../src/azureBlobSas.ts";
import type { AppConfig } from "../src/config.ts";
import { getDb } from "../src/db_npm.ts";
import { createSharedHostingRuntime } from "../src/sharedHostingRuntime.ts";

const acknowledgement = "I_UNDERSTAND_THIS_MAY_CREATE_RESOURCES";
if (process.env.XMCL_PROCESS_CAPACITY !== acknowledgement) {
  throw new Error(
    `Set XMCL_PROCESS_CAPACITY=${acknowledgement} to process a capacity request`,
  );
}

const config = process.env as AppConfig;
const signer = createAzureBlobSasSigner({
  endpoint: config.XMCL_AZURE_BLOB_ENDPOINT,
  container: config.XMCL_AZURE_BLOB_CONTAINER,
  accountName: config.XMCL_AZURE_STORAGE_ACCOUNT_NAME,
  accountKey: config.XMCL_AZURE_STORAGE_ACCOUNT_KEY,
});
const runtime = createSharedHostingRuntime(
  await getDb(config),
  config,
  signer,
);
const processed = await runtime.scheduler.processCapacityRequests(1);
console.log(`Processed ${processed} shared-hosting capacity request(s).`);
process.exit(0);
