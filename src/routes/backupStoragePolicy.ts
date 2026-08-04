import { Hono } from "hono";
import type { AppEnv } from "../types.ts";
import { handleAccountError } from "../lib/accountHttp.ts";
import { getAccountRuntime } from "../lib/accountRuntime.ts";
import type { AccountRuntimeResolver } from "../middleware/xmclAuth.ts";
import { xmclAuth } from "../middleware/xmclAuth.ts";

export const BACKUP_STORAGE_POLICY_V1 = Object.freeze({
  freeBytes: 1_073_741_824,
  policyVersion: 1,
});

export function createBackupStoragePolicyRoutes(
  resolve: AccountRuntimeResolver = getAccountRuntime,
) {
  const app = new Hono<AppEnv>();
  app.onError(handleAccountError);
  app.use("/v1/backup-storage-policy", xmclAuth([], resolve));
  app.get("/v1/backup-storage-policy", (c) => c.json(BACKUP_STORAGE_POLICY_V1));
  return app;
}

export default createBackupStoragePolicyRoutes();
