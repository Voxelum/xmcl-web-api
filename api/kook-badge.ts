import { defineApi } from "../type.ts";
interface KookResponse {
    open_id: string | null
    name: string
    icon: string
    online_count: string
}
export default defineApi((router) => {
    router.get('/kook-badge', async (ctx) => {
        const response = await fetch("https://kookapp.cn/api/guilds/2998646379574089/widget.json")
        const content: KookResponse = await response.json()
        const decoder = new TextDecoder('utf-8')
        const fileContent = await Deno.readFile('./favicon-kook.svg')
        const svg = decoder.decode(fileContent)

        ctx.response.body = {
            schemaVersion: 1,
            label: 'KOOK',
            logoSvg: svg,
            message: `${content.online_count} 人在线`,
            labelColor: "87eb00"
        }
    })
}) 