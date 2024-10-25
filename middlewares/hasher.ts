import * as XXH64 from "https://deno.land/x/xxhash64@1.1.0/mod.ts";
import { Middleware } from "oak";

export interface WithHasher {
  hasher: XXH64.Hasher;
}

export const hasherMiddlware: Middleware<WithHasher> = async (
  ctx,
  next,
) => {
  const hasher = await XXH64.create3()
  ctx.state.hasher = hasher;
  await next();
};
