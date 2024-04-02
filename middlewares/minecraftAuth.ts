import { Middleware, Status } from "oak";
import { MicrosoftMinecraftProfile } from "../type.ts";

export interface MinecraftAuthState {
  profile: MicrosoftMinecraftProfile;
}
export const minecraftAuthMiddleware: Middleware<
  MinecraftAuthState
> = async (ctx, next) => {
  const authorization = ctx.request.headers.get("authorization");
  if (!authorization || !authorization.startsWith("Bearer ")) {
    return ctx.throw(Status.BadRequest, "Require authorization header");
  }

  const response = await fetch(
    "https://api.minecraftservices.com/minecraft/profile",
    {
      method: "GET",
      headers: { authorization },
    },
  );
  if (response.status !== 200) {
    ctx.response.body = await response.text();
    console.error(ctx.response.body);
    throw ctx.throw(Status.Unauthorized);
  }
  ctx.state.profile = await response.json() as MicrosoftMinecraftProfile;
  await next();
};
