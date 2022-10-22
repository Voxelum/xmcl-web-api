import { serve } from "https://deno.land/std@0.142.0/http/server.ts";
import handleLatest from "./api/latest.ts"
import handleAfdianBadge from "./api/afdian-badge.ts"
import handleKookBadge from "./api/kook-badge.ts"
import handleGroup from "./api/group.ts"

serve((req: Request) => {
    const parsed = new URL(req.url)
    if (parsed.pathname.endsWith('/latest')) {
        return handleLatest(req, parsed)
    }
    if (parsed.pathname.endsWith('/afdian-badge')) {
        return handleAfdianBadge(req, parsed)
    }
    if (parsed.pathname.endsWith('/kook-badge')) {
        return handleKookBadge(req, parsed)
    }
    if (parsed.pathname.endsWith('/group')) {
        return  handleGroup(req, parsed)
    }
    return Response.json({ error: 'Not Found' }, { status: 404 })
});
