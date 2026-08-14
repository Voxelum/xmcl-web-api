import process from "node:process";
import {
  LIGHTNODE_MVP_REGIONS,
  LightNodeOpenApiClient,
} from "../src/lightnode.ts";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const client = new LightNodeOpenApiClient({
  token: required("LIGHTNODE_API_TOKEN"),
  baseUrl: process.env.LIGHTNODE_API_BASE_URL,
});

const result = [];
for (const logicalRegion of ["mow", "tpe"] as const) {
  const location = await client.validateMvpRegion(logicalRegion);
  const [packages, images, firewalls] = await Promise.all([
    client.listPackages(location.regionCode, location.zoneCode),
    client.listImages(location.regionCode),
    client.listFirewalls(location.regionCode),
  ]);
  result.push({
    logicalRegion,
    ...LIGHTNODE_MVP_REGIONS[logicalRegion],
    villageCapablePackages: packages.filter((value) =>
      value.cpu >= 8 &&
      value.memoryGiB >= 16 &&
      value.dataDiskGiB >= 64
    ),
    privateImages: images.filter((value) => value.imageType === "Self"),
    availableFirewalls: firewalls.filter((value) =>
      value.firewallStatus === "AVAILABLE"
    ),
  });
}

console.log(JSON.stringify(result, undefined, 2));
