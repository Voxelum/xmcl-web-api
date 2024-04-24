import { Middleware, Status } from "oak";
import { MicrosoftMinecraftProfile } from "../type.ts";

export interface MinecraftAuthState {
  profile: MicrosoftMinecraftProfile;
}

export function getMinecraftAuthMiddleware(strict = true) {
  const minecraftAuthMiddleware: Middleware<
    MinecraftAuthState
  > = async (ctx, next) => {
    const authorization = ctx.request.headers.get("authorization");
    if (!authorization || !authorization.startsWith("Bearer ")) {
      if (strict) {
        return ctx.throw(Status.BadRequest, "Require authorization header");
      }
    }

    if (authorization) {
      const response = await fetch(
        "https://api.minecraftservices.com/minecraft/profile",
        {
          method: "GET",
          headers: { authorization },
        },
      );
      if (response.status !== 200) {
        ctx.response.body = await response.text();
        if (strict) {
          console.error(ctx.response.body);
          return ctx.throw(Status.Unauthorized);
        }
      } else {
        ctx.state.profile = await response.json() as MicrosoftMinecraftProfile;
      }
    }
    await next();
  };
  return minecraftAuthMiddleware as typeof strict extends true ? Middleware<MinecraftAuthState> : Middleware<Partial<MinecraftAuthState>>
}
