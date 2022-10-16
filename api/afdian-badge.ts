import { defineApi } from "../type.ts";
import { createHash } from "https://deno.land/std@0.142.0/hash/mod.ts";

interface AfdianResponse {
    data: {
        total_count: number
    }
}

export default defineApi(async (req) => {
    const token = Deno.env.get('AFDIAN_TOKEN')
    const body = {
        user_id: Deno.env.get('AFDIAN_USER_ID'),
        params: JSON.stringify({ page: 1 }),
        ts: Math.floor(Date.now() / 1000),
    }
    const sign = createHash("md5").update(`${token}params${body.params}ts${body.ts}user_id${body.user_id}`).toString('hex')
    const bodyContent = JSON.stringify({
        ...body,
        sign,
    })
    const response = await fetch("https://afdian.net/api/open/query-sponsor", {
        method: 'POST',
        body: bodyContent,
        headers: {
            'Content-Type': 'application/json',
        },
    })
    const content: AfdianResponse = await response.json()
    const fileContent = await Deno.readFile('./afdian.svg')
    const decoder = new TextDecoder('utf-8')
    const svg = decoder.decode(fileContent)

    return Response.json({
        schemaVersion: 1,
        label: "爱发电",
        color: "946ce6",
        logoSvg: svg,
        message: `${content.data.total_count} 位天使`,
    })
}) 