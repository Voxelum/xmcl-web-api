import xxhash from "xxhash-wasm";

/**
 * Cross-runtime xxhash64 string hasher (Deno, Node/Azure, Cloudflare Workers).
 *
 * The original service used `deno.land/x/xxhash64` which is Deno-only. Since the
 * whole service now shares this implementation, the hash only needs to be
 * self-consistent: it keys the translation cache and detects stale entries.
 */
let hasherPromise: Promise<(input: string) => string> | undefined;

export function getHasher(): Promise<(input: string) => string> {
  if (!hasherPromise) {
    hasherPromise = xxhash().then((api) => (input: string) =>
      api.h64ToString(input)
    );
  }
  return hasherPromise;
}
