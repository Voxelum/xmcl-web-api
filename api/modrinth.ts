import { Router } from "oak";

export default new Router().get("/modrinth/auth", async (ctx) => {
    const request = ctx.request;

    const url = new URL("https://api.modrinth.com/_internal/oauth/token");
    const response = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: Deno.env.get('MODRINTH_SECRET') || "",
            'Content-Type': 'application/x-www-form-urlencoded',
            ['User-Agent']: ctx.request.headers.get('User-Agent') || "",
        },
        body: new URLSearchParams({
            client_id: "GFz0B21y",
            redirect_uri: request.url.searchParams.get("redirect_uri") || "",
            code: request.url.searchParams.get("code") || "",
            grant_type: "authorization_code",
        })
    })

    ctx.response.status = response.status;
    ctx.response.headers = response.headers;
    ctx.response.body = response.body;
})