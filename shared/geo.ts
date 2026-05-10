import geoip from "npm:geoip-country";

// Returns true if the request appears to come from mainland China,
// based on the proxy-forwarded client IP. Mirrors the Node-side check in
// azure/index.ts so the two runtimes route identically.
//
// Falls back to false on any uncertainty (no header, malformed IP, no geo
// hit, no country) -- defaulting non-CN means we send those users to
// GitHub Releases / origin, which is the desired behaviour for the rest
// of the world.
export function isChineseIP(headers: Headers): boolean {
  const ip = headers.get("x-forwarded-for") || headers.get("x-real-ip");
  if (!ip) return false;

  // x-forwarded-for can be a comma-separated chain ("client, proxy1, proxy2")
  // and may include a :port suffix; take the first hop and strip the port.
  const first = ip.split(",")[0].trim();
  const ipOnly = first.split(":")[0].trim();
  if (!ipOnly) return false;

  const geo = geoip.lookup(ipOnly);
  return geo?.country === "CN";
}
