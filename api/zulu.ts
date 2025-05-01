import { Router } from "oak";

export default new Router().get("/zulu", async (ctx) => {
    const response = await fetch('https://raw.githubusercontent.com/Voxelum/xmcl-static-resource/refs/heads/main/zulu.json', {
        headers: ctx.request.headers,
    })
    ctx.response.status = response.status
    ctx.response.headers = response.headers 
    ctx.response.body = response.body
});
