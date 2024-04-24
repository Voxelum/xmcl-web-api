import { Router } from "oak";
import { getMinecraftAuthMiddleware } from '../middlewares/minecraftAuth.ts';

const router = new Router();

function isValidModrinthValue(text: string) {
    // The modrinth value should be a valid base64 string 
    try {
        atob(text)
    } catch {
        return false
    }
    return true
}
function isValidCurseforgeValue(text: string) {
    // The curseforge value should be a number
    return Number.isInteger(Number(text))
}

function isValidSheet(o: object, validator: (v: string) => boolean) {
    for (const [k, v] of Object.entries(o)) {
        if (typeof v !== "string" || !validator(v)) return false
        if (typeof k !== "string" || !validator(k)) return false
    }
    return true
}

type Modsheets = {
    [key: string]: {
        public?: boolean,
        modrinth?: Record<string, string>,
        curseforge?: Record<string, string>
    }
}

router.get("/mod-sheets", getMinecraftAuthMiddleware(), async (ctx) => {
    const kv = await Deno.openKv();
    const profile = ctx.state.profile
    const modSheet = await kv.get(["mod-sheets", profile.id])
    if (!modSheet.value) {
        ctx.throw(404)
        return
    }
    const record = modSheet.value as Modsheets
    ctx.response.body = record
    ctx.response.status = 200
}).get("/mod-sheets/:user", async (ctx) => {
    const kv = await Deno.openKv();
    const modSheet = await kv.get(["mod-sheets", ctx.params.user])
    if (!modSheet.value) {
        ctx.throw(404)
        return
    }
    const record = modSheet.value as Modsheets
    const publicRecord = Object.fromEntries(Object.entries(record).filter(([_, v]) => v.public))
    ctx.response.body = publicRecord
    ctx.response.status = 200
}).post("/mod-sheets", getMinecraftAuthMiddleware(), async (ctx) => {
    const kv = await Deno.openKv();
    const profile = ctx.state.profile
    const record = await ctx.request.body.json() as Modsheets
    for (const [k, sheet] of Object.entries(record)) {
        if (sheet.curseforge) {
            if (typeof sheet.curseforge !== "object") {
                ctx.throw(400, `Invalid value for key ${k}`)
                return
            }
            if (!isValidSheet(sheet.curseforge, isValidCurseforgeValue)) {
                ctx.throw(400, `Invalid value for key ${k}`)
                return
            }
        }
        if (sheet.modrinth) {
            if (typeof sheet.modrinth !== "object") {
                ctx.throw(400, `Invalid value for key ${k}`)
                return
            }
            if (!isValidSheet(sheet.modrinth, isValidModrinthValue)) {
                ctx.throw(400, `Invalid value for key ${k}`)
                return
            }
        }
        if (typeof sheet.public !== "undefined" && typeof sheet.public !== "boolean") {
            ctx.throw(400, `Invalid value for key ${k}`)
            return
        }
    }
    await kv.set(["mod-sheets", profile.id], record)
    ctx.response.status = 201
    ctx.response.body = record
});

export default router;