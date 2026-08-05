const ROOM_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function normalizeMultiplayerRoomId(
  value: string,
): string | undefined {
  const normalized = value.toLowerCase();
  return ROOM_ID_PATTERN.test(normalized) ? normalized : undefined;
}
