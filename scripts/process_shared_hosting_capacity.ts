import process from "node:process";
import type { AppConfig } from "../src/config.ts";
import { getDb } from "../src/db_npm.ts";
import { createS3SigV4Presigner } from "../src/s3SigV4.ts";
import { createSharedHostingRuntime } from "../src/sharedHostingRuntime.ts";

const acknowledgement = "I_UNDERSTAND_THIS_MAY_CREATE_RESOURCES";
if (process.env.XMCL_PROCESS_CAPACITY !== acknowledgement) {
  throw new Error(
    `Set XMCL_PROCESS_CAPACITY=${acknowledgement} to process a capacity request`,
  );
}

const config = process.env as AppConfig;
const signer = createS3SigV4Presigner({
  endpoint: config.XMCL_VULTR_OBJECT_STORAGE_ENDPOINT,
  region: config.XMCL_VULTR_OBJECT_STORAGE_REGION,
  bucket: config.XMCL_VULTR_OBJECT_STORAGE_BUCKET,
  accessKey: config.XMCL_VULTR_OBJECT_STORAGE_ACCESS_KEY,
  secretKey: config.XMCL_VULTR_OBJECT_STORAGE_SECRET_KEY,
});
const runtime = createSharedHostingRuntime(
  await getDb(config),
  config,
  signer,
);
const processed = await runtime.scheduler.processCapacityRequests(1);
console.log(`Processed ${processed} shared-hosting capacity request(s).`);
process.exit(0);
