import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { checkMicrosoftAuthenticate } from "../utils/checkMicrosoftAuthenticate.ts";
import type { AppEnv, MicrosoftMinecraftProfile } from "../types.ts";

/**
 * Verifies a Minecraft bearer token against the Mojang profile endpoint and,
 * on success, stores the profile on the context as `minecraftProfile`.
 *
 * When `strict` is false a missing or invalid token is tolerated (the profile
 * is simply left unset).
 */
export function minecraftAuth(strict = true) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const authorization = c.req.header("authorization");

    if (!authorization || !authorization.startsWith("Bearer ")) {
      if (strict) {
        throw new HTTPException(400, { message: "Require authorization header" });
      }
    }

    if (authorization) {
      const response = await fetch(
        "https://api.minecraftservices.com/minecraft/profile",
        { method: "GET", headers: { authorization } },
      );
      if (response.status !== 200) {
        const body = await response.text();
        if (strict) {
          console.error(body);
          throw new HTTPException(401, { message: body });
        }
      } else {
        c.set(
          "minecraftProfile",
          (await response.json()) as MicrosoftMinecraftProfile,
        );
      }
    }

    await next();
  });
}

/**
 * Verifies a Microsoft Graph bearer token and stores the resolved profile as
 * `microsoftProfile`.
 */
export const microsoftAuth = createMiddleware<AppEnv>(async (c, next) => {
  const authorization = c.req.header("authorization");
  if (!authorization || !authorization.startsWith("Bearer ")) {
    throw new HTTPException(400, { message: "Require authorization header" });
  }

  const accessToken = authorization.substring("Bearer ".length);
  try {
    const profile = await checkMicrosoftAuthenticate(accessToken);
    c.set("microsoftProfile", profile);
  } catch {
    throw new HTTPException(401);
  }

  await next();
});
