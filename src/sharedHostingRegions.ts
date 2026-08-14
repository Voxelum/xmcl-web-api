import { AccountError } from "./account.ts";

export interface SharedHostingRegion {
  regionId: string;
  city: string;
  country: string;
  latencyTestUrl: string;
}

export const SHARED_HOSTING_REGIONS: readonly SharedHostingRegion[] = [
  {
    regionId: "mow",
    city: "Moscow",
    country: "RU",
    latencyTestUrl: "https://www.lightnode.com/en-US/speed/ru-moscow-1",
  },
  {
    regionId: "tpe",
    city: "Taipei",
    country: "TW",
    latencyTestUrl: "https://www.lightnode.com/en-US/speed/cn-taiwan-1",
  },
  {
    regionId: "ams",
    city: "Amsterdam",
    country: "NL",
    latencyTestUrl: "https://ams-nl-ping.vultr.com/",
  },
  {
    regionId: "atl",
    city: "Atlanta",
    country: "US",
    latencyTestUrl: "https://ga-us-ping.vultr.com/",
  },
  {
    regionId: "blr",
    city: "Bangalore",
    country: "IN",
    latencyTestUrl: "https://blr-in-ping.vultr.com/",
  },
  {
    regionId: "ewr",
    city: "New Jersey",
    country: "US",
    latencyTestUrl: "https://nj-us-ping.vultr.com/",
  },
  {
    regionId: "lax",
    city: "Los Angeles",
    country: "US",
    latencyTestUrl: "https://lax-ca-us-ping.vultr.com/",
  },
  {
    regionId: "lhr",
    city: "London",
    country: "GB",
    latencyTestUrl: "https://lon-gb-ping.vultr.com/",
  },
  {
    regionId: "nrt",
    city: "Tokyo",
    country: "JP",
    latencyTestUrl: "https://hnd-jp-ping.vultr.com/",
  },
  {
    regionId: "ord",
    city: "Chicago",
    country: "US",
    latencyTestUrl: "https://il-us-ping.vultr.com/",
  },
  {
    regionId: "sea",
    city: "Seattle",
    country: "US",
    latencyTestUrl: "https://wa-us-ping.vultr.com/",
  },
  {
    regionId: "sgp",
    city: "Singapore",
    country: "SG",
    latencyTestUrl: "https://sgp-ping.vultr.com/",
  },
  {
    regionId: "syd",
    city: "Sydney",
    country: "AU",
    latencyTestUrl: "https://syd-au-ping.vultr.com/",
  },
] as const;

export function enabledSharedHostingRegions(
  regionIds: readonly string[],
): SharedHostingRegion[] {
  const unique = new Set(regionIds);
  if (unique.size === 0 || unique.size !== regionIds.length) {
    throw new Error("shared hosting regions must be non-empty and unique");
  }
  return regionIds.map((regionId) => {
    const region = SHARED_HOSTING_REGIONS.find((item) =>
      item.regionId === regionId
    );
    if (!region) {
      throw new Error(`unsupported shared hosting region: ${regionId}`);
    }
    return structuredClone(region);
  });
}

export function requireSharedHostingRegion(
  regionId: string,
  enabledRegions: readonly SharedHostingRegion[],
) {
  const region = enabledRegions.find((item) => item.regionId === regionId);
  if (!region) throw new AccountError(422, "shared_region_not_available");
  return region;
}
