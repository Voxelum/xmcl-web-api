import { Router } from "oak";

export interface LauncherNotification {
    id: string
    type: 'criticle_update_web' | 'criticle_update' | 'news' | 'info'
    date: string
    title: string
    body: string
}

export default new Router().get("/notifications", async (ctx) => {
    const request = ctx.request;
    const version = request.url.searchParams.get("version");
    const osRelease = request.url.searchParams.get("osRelease");
    const os = request.url.searchParams.get("os");
    const arch = request.url.searchParams.get("arch");
    const env = request.url.searchParams.get("env");
    const build = request.url.searchParams.get("build");
    const locale = request.url.searchParams.get("locale");

    ctx.response.body = [];
})