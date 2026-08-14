import { MongoClient } from "mongodb";
import process from "node:process";
import type { Db } from "../src/db.ts";
import {
  hashSharedNodeToken,
  MongoSharedNodeCredentialRepository,
} from "../src/sharedNodeTransport.ts";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name: string) {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const nodeId = required("XMCL_PREPROVISIONED_NODE_ID");
const region = required("XMCL_PREPROVISIONED_NODE_REGION");
if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(nodeId)) {
  throw new Error("XMCL_PREPROVISIONED_NODE_ID is invalid");
}
if (region !== "mow" && region !== "tpe") {
  throw new Error("XMCL_PREPROVISIONED_NODE_REGION must be mow or tpe");
}
const totalMemoryMiB = positiveInteger(
  "XMCL_PREPROVISIONED_NODE_TOTAL_MEMORY_MIB",
);
const totalSharedCpu = positiveInteger(
  "XMCL_PREPROVISIONED_NODE_TOTAL_SHARED_CPU",
);
const totalWorkspaceGiB = positiveInteger(
  "XMCL_PREPROVISIONED_NODE_TOTAL_WORKSPACE_GIB",
);
const instanceId = required("XMCL_PREPROVISIONED_NODE_INSTANCE_ID");
const ttlHours = Number(process.env.XMCL_PREPROVISIONED_ENROLLMENT_TTL_HOURS ??
  "24");
if (!Number.isSafeInteger(ttlHours) || ttlHours < 1 || ttlHours > 168) {
  throw new Error(
    "XMCL_PREPROVISIONED_ENROLLMENT_TTL_HOURS must be between 1 and 168",
  );
}

const mongo = new MongoClient(required("MONGO_CONNECION_STRING"));
await mongo.connect();
try {
  const repository = new MongoSharedNodeCredentialRepository(
    mongo.db(required("MONGODB_NAME")) as unknown as Db,
  );
  const existing = await repository.findEnrollment(nodeId);
  if (
    existing &&
    !existing.consumedAt &&
    Date.parse(existing.expiresAt) > Date.now()
  ) {
    throw new Error(
      "an unconsumed enrollment already exists for this node",
    );
  }
  const token = crypto.randomUUID().replaceAll("-", "") +
    crypto.randomUUID().replaceAll("-", "");
  await repository.saveEnrollment({
    nodeId,
    provisioningRequestId: `preprovisioned:${instanceId}`,
    instanceId,
    expectedCapacity: {
      workloadClasses: ["standard", "large"],
      totalMemoryMiB,
      totalSharedCpu,
      totalWorkspaceGiB,
    },
    oneTimeTokenHash: await hashSharedNodeToken(token),
    expiresAt: new Date(Date.now() + ttlHours * 60 * 60_000).toISOString(),
  });
  console.log(JSON.stringify({
    nodeId,
    region,
    bootstrapCredential: token,
    expiresInHours: ttlHours,
    expectedCapacity: {
      workloadClasses: ["standard", "large"],
      totalMemoryMiB,
      totalSharedCpu,
      totalWorkspaceGiB,
    },
  }, undefined, 2));
} finally {
  await mongo.close();
}
