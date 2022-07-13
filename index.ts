import { serve } from "https://deno.land/std@0.142.0/http/server.ts";
import { gt } from "https://deno.land/x/semver/mod.ts"
import { createHash } from "https://deno.land/std@$STD_VERSION/hash/mod.ts";


interface GithubReleaseItem {
    tag_name: string
    prerelease: boolean
    body: string
    assets: Array<{
        name: string
        browser_download_url: string
    }>
}

interface KookResponse {
    open_id: string | null
    name: string
    icon: string
    online_count: string
}

interface AfdianResponse {
    data: {
        total_count: number
    }
}

serve(async (req: Request) => {
    const parsed = new URL(req.url)
    if (parsed.pathname.endsWith('/latest')) {
        const includePrerelease = parsed.searchParams.has('prerelease')
        const response = await fetch('https://api.github.com/repos/voxelum/x-minecraft-launcher/releases?per_page=5', {
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'Authorization': `token ${Deno.env.get('GITHUB_PAT')}`,
            }
        })
        const version = parsed.searchParams.get('version')
        const releases: GithubReleaseItem[] = await response.json()
        if (version) {
            const filtered = releases.filter(r => gt(r.tag_name, version))
            const latest = filtered.shift()!

            for (const r of filtered) {
                latest.body += `\n${r.body}\n`
            }

            return Response.json(latest)
        } else {
            const filtered = releases.filter(v => includePrerelease ? true : !v.prerelease)[0]
            return Response.json(filtered)
        }
    }
    if (parsed.pathname.endsWith('/afdian-badge')) {
        const token = Deno.env.get('AFDIAN_TOKEN')
        const body = {
            user_id: Deno.env.get('AFDIAN_USER_ID'),
            params: "{}",
            ts: Math.floor(Date.now() / 1000),
        }
        const response = await fetch("https://afdian.net/api/open/query-sponsor", {
            method: 'POST',
            body: JSON.stringify({
                ...body,
                sign: createHash("md5").update(`${token}params${body.params}ts${body.ts}user_id${body.user_id}`).digest(),
            }),
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
    }
    if (parsed.pathname.endsWith('/kook-badge')) {
        const response = await fetch("https://kookapp.cn/api/guilds/2998646379574089/widget.json")
        const content: KookResponse = await response.json()
        const decoder = new TextDecoder('utf-8')
        const fileContent = await Deno.readFile('./favicon-kook.svg')
        const svg = decoder.decode(fileContent)

        return Response.json({
            schemaVersion: 1,
            label: 'KOOK',
            logoSvg: svg,
            message: `${content.online_count} 人在线`,
            labelColor: "87eb00"
        })
    }
    return Response.json({ error: 'Not Found' }, { status: 404 })
});
