const LAUNCHER_CALLBACK_PORT_START = 25_555;
const LAUNCHER_CALLBACK_PORT_INCREMENT = 7;
const LAUNCHER_CALLBACK_PATH = "/commercial-auth";

export interface OAuthRedirectPolicy {
  readonly declaredRedirectUris: readonly string[];
  allows(redirectUri: string): boolean;
}

export function createOAuthRedirectPolicy(
  configuredRedirectUris: readonly string[],
): OAuthRedirectPolicy {
  const declaredRedirectUris = configuredRedirectUris.filter(
    isExactHttpsCallback,
  );
  const declared = new Set(declaredRedirectUris);

  return {
    declaredRedirectUris,
    allows(redirectUri) {
      return isLauncherCallback(redirectUri) || declared.has(redirectUri);
    },
  };
}

function isExactHttpsCallback(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" &&
    url.hostname.length > 0 &&
    !url.hostname.includes("*") &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    url.toString() === value;
}

export function isLauncherCallback(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const port = Number(url.port);
  return url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    !url.username &&
    !url.password &&
    url.pathname === LAUNCHER_CALLBACK_PATH &&
    !url.search &&
    !url.hash &&
    Number.isInteger(port) &&
    port >= LAUNCHER_CALLBACK_PORT_START &&
    port <= 65_535 &&
    (port - LAUNCHER_CALLBACK_PORT_START) % LAUNCHER_CALLBACK_PORT_INCREMENT ===
      0 &&
    value === `http://127.0.0.1:${port}${LAUNCHER_CALLBACK_PATH}`;
}
