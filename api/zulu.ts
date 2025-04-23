import { Router } from "oak";
import content from '../utils/zulu.json' with { type: "json" }

export default new Router().get("/zulu", (ctx) => {
    // handle if-modified-since
    const ifModifiedSince = ctx.request.headers.get("if-modified-since");
    if (ifModifiedSince) {
        const lastModified = new Date(content.modified);
        const ifModifiedDate = new Date(ifModifiedSince);
        if (lastModified <= ifModifiedDate) {
            ctx.response.status = 304;
            return;
        }
    }

    ctx.response.body = content
});
