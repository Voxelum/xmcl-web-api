export function getFlights(
  version: string | null,
  locale: string | null,
  build: string | null
) {
  if (!version || !locale) {
    return {}
  }
  if (build && Number(build) > 1002) {
    return {
      i18nSearch: ['zh-CN', 'zh-TW', 'ru']
    };
  }
  return {}
}