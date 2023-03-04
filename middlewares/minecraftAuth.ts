import { Middleware, Status } from "https://deno.land/x/oak@v11.1.0/mod.ts";
import {
  getMicrosoftMinecraftProfile,
  MicrosoftMinecraftProfile,
} from "../utils/getMicrosoftProfile.ts";

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

  const accessToken = authorization.substring("Bearer ".length);

  try {
    const profile = await getMicrosoftMinecraftProfile(accessToken);
    ctx.state.profile = profile;
    await next();
  } catch {
    ctx.throw(Status.Unauthorized);
  }
};
