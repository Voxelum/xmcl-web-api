import { gte, valid } from "semver";

export function getFlights(
  version: string | null,
  locale: string | null,
  build: string | null,
) {
  if (!version || !locale) {
    return {};
  }
  const agentTelemetry = valid(version) !== null && gte(version, "0.68.0");
  const flights: Record<string, boolean | string[]> = {
    agentTelemetry,
  };
  if (build && Number(build) > 1002) {
    flights.i18nSearch = ["zh-CN", "zh-TW", "ru"];
  }
  return flights;
}
