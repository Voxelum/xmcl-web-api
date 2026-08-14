import assert from "node:assert/strict";
import {
  enabledSharedHostingRegions,
  SHARED_HOSTING_REGIONS,
} from "./sharedHostingRegions.ts";

Deno.test("shared hosting catalog exposes vendor-neutral LightNode MVP regions", () => {
  const mvp = enabledSharedHostingRegions(["mow", "tpe"]);

  assert.deepEqual(
    mvp.map((region) => ({
      regionId: region.regionId,
      city: region.city,
      country: region.country,
    })),
    [
      { regionId: "mow", city: "Moscow", country: "RU" },
      { regionId: "tpe", city: "Taipei", country: "TW" },
    ],
  );
  assert.match(mvp[0].latencyTestUrl, /ru-moscow-1/);
  assert.match(mvp[1].latencyTestUrl, /cn-taiwan-1/);
  assert.equal(
    SHARED_HOSTING_REGIONS.some((region) =>
      region.regionId.startsWith("ru-") || region.regionId.startsWith("cn-")
    ),
    false,
  );
});
