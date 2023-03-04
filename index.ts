import { serve } from "https://deno.land/std@0.142.0/http/server.ts";
import { gt } from "https://deno.land/std/semver/mod.ts"
import { createHash } from "https://deno.land/std@0.142.0/hash/mod.ts";

import latest from "./api/latest.ts"
import afdianBadge from "./api/afdian-badge.ts"
import kookBadge from "./api/kook-badge.ts"
import rtc from "./api/rtc.ts"
import group from "./api/group.ts"
import proxy from "./api/proxy.ts"

const app = new Application();
const router = new Router();

latest(router)
afdianBadge(router)
kookBadge(router)
rtc(router)
group(router)

// proxy(router)

app.use(router.routes())
app.use(router.allowedMethods())

app.listen({ port: 8080 })
