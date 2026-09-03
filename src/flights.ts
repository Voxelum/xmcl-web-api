import { gte, valid } from "semver";

export function getFlights(
  version: string | null,
  locale: string | null,
  build: string | null,
) {
  if (!version || !locale) {
    return {};
  }
  const flights: Record<string, boolean | string[]> = {};
  if (build && Number(build) > 1002) {
    flights.i18nSearch = ["zh-CN", "zh-TW", "ru"];
  }
  if (valid(version) && gte(version, "0.68.0")) {
    flights.agentTelemetry = true;
  }
  return flights;
}
