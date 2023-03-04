import {
Middleware,
  RouteParams,
  RouterMiddleware,
  Status,
} from "https://deno.land/x/oak@v11.1.0/mod.ts";
import {
  checkMicrosoftAuthenticate,
  MicrosoftProfile,
} from "../utils/checkMicrosoftAuthenticate.ts";

export interface MicrosoftAuthState {
  profile: MicrosoftProfile;
}
export const microsoftAuthMiddleware: Middleware<
  MicrosoftAuthState
> = async (ctx, next) => {
  const authorization = ctx.request.headers.get("authorization");
  if (!authorization || !authorization.startsWith("Bearer ")) {
    return ctx.throw(Status.BadRequest, "Require authorization header");
  }

  const accessToken = authorization.substring("Bearer ".length);

  try {
    const profile = await checkMicrosoftAuthenticate(accessToken);
    ctx.state.profile = profile;
    await next();
  } catch {
    ctx.throw(Status.Unauthorized);
  }
};
