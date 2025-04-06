import { Router } from "oak";

export default new Router().get("/modrinth/auth", async (ctx) => {
    const request = ctx.request;

    const response = await fetch("https://api.modrinth.com/_internal/oauth/token", {
        method: "POST",
        headers: {
            ["Content-Type"]: "application/json",
            Authorization: Deno.env.get('MODRINTH_SECRET') || "",
        },
        body: JSON.stringify({
            code: request.url.searchParams.get("code"),
            client_id: "GFz0B21y",
            redirect_uri: request.url.searchParams.get("redirect_uri"),
            grant_type: "authorization_code",
        })
    })

    ctx.response.status = response.status;
    ctx.response.headers = response.headers;
    ctx.response.body = response.body;
})