import { Router } from "oak";

export default new Router().get("/modrinth/auth", async (ctx) => {
    const request = ctx.request;

    const url = new URL("https://api.modrinth.com/_internal/oauth/token");
    url.searchParams.set("client_id", "GFz0B21y");
    url.searchParams.set("redirect_uri", request.url.searchParams.get("redirect_uri") || "");
    url.searchParams.set("code", request.url.searchParams.get("code") || "");
    url.searchParams.set("grant_type", "authorization_code");

    const response = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: Deno.env.get('MODRINTH_SECRET') || "",
            'Content-Type': 'application/x-www-form-urlencoded',
            ['User-Agent']: ctx.request.headers.get('User-Agent') || "",
        },
    })

    ctx.response.status = response.status;
    ctx.response.headers = response.headers;
    ctx.response.body = response.body;
})