import * as XXH64 from "https://deno.land/x/xxhash64@1.1.0/mod.ts";
import { Middleware } from "oak";

export interface WithHasher {
  hasher: XXH64.Hasher;
}

const promise = XXH64.create3()

export const hasherMiddlware: Middleware<WithHasher> = async (
  ctx,
  next,
) => {
  const hasher = await promise
  ctx.state.hasher = hasher;
  await next();
};
