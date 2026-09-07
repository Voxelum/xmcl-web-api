declare module "geoip-country" {
  interface GeoIpResult {
    country?: string;
  }

  const geoip: {
    lookup(ip: string): GeoIpResult | null;
  };

  export default geoip;
}

declare module "semver" {
  export function gte(left: string, right: string): boolean;
  export function lt(left: string, right: string): boolean;

  export class Range {
    constructor(range: string);
    test(version: string): boolean;
  }
}
