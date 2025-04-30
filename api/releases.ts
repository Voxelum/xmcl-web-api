import { Router } from "oak";

// match /releases/<filename>
export default new Router().get("/releases/:filename", async (ctx) => {
    // redirect to github releases
    const fileName = ctx.params.filename;
    const version = fileName.split('-')[1];
    ctx.response.redirect(`https://github.com/Voxelum/x-minecraft-launcher/releases/download/v${version}/${fileName}`);
})