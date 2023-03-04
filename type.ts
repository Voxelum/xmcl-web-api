import { Router } from "https://deno.land/x/oak@v11.1.0/mod.ts";

export function defineApi(func: (router: Router) => void) {
    return func
}