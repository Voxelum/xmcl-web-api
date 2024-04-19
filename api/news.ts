import { Router } from "oak";

export interface LauncherNews {
    category: string
    image: string
    date: string
    title: string
    description: string
    link: string
}

export default new Router().get("/news", async (ctx) => {
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