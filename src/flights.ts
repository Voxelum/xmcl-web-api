export function getFlights(
  version: string | null,
  locale: string | null,
  build: string | null,
) {
  if (!version || !locale) {
    return {};
  }
  // The launcher merges remote flights into its cache, so omission does not
  // clear a previously cached true value.
  const flights: Record<string, boolean | string[]> = {
    agentTelemetry: false,
  };
  if (build && Number(build) > 1002) {
    flights.i18nSearch = ["zh-CN", "zh-TW", "ru"];
  }
  return flights;
}
