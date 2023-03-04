import { Router } from "https://deno.land/x/oak@v11.1.0/mod.ts";

export function defineApi<T extends Record<string, any>>(func: (router: Router<T>) => void) {
  return func;
}
