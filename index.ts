import { serve } from "https://deno.land/std@0.142.0/http/server.ts";
import { gte } from "https://deno.land/x/semver/mod.ts"
import { createHash } from "https://deno.land/std@0.142.0/hash/mod.ts";


interface GithubReleaseItem {
    tag_name: string
    prerelease: boolean
    body: string
    assets: Array<{
        name: string
        browser_download_url: string
    }>
    draft: boolean
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
        const response = await fetch('https://api.github.com/repos/voxelum/x-minecraft-launcher/releases?per_page=10', {
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'Authorization': `token ${Deno.env.get('GITHUB_PAT')}`,
            }
        })

        const langs = req.headers.get('Accept-Language')

        let lang = ''
        if (langs) {
            const langItems = langs.split(';')
            for (const item of langItems) {
                if (item.indexOf('zh') !== -1) {
                    lang = 'zh'
                    break
                } else if (item.indexOf('en') !== -1) {
                    lang = 'en'
                    break
                }
            }
        }

        const version = parsed.searchParams.get('version')
        const releases: GithubReleaseItem[] = await response.json()
        if (version) {
            const filtered = releases.filter(r => gte(r.tag_name.substring(1), version) && !r.draft)
            const latest = filtered[0]
            // reset body
            const changelogs: string[] = []

            for (const r of filtered) {
                const v = r.tag_name.startsWith('v') ? r.tag_name.substring(1) : r.tag_name
                if (lang) {
                    try {
                        const response = await fetch(`https://raw.githubusercontent.com/voxelum/xmcl-page/master/src/pages/${lang}/changelogs/${v}.md`)
                        const markdown = await response.text()
                        const content = markdown.substring(markdown.lastIndexOf('---') + 4)
                        changelogs.push(content)
                    } catch {
                        changelogs.push(r.body)
                    }
                } else {
                    changelogs.push(r.body)
                }
            }

            latest.body = changelogs.join('\n\n')

            return Response.json(latest)
        } else {
            const filtered = releases.filter(v => (includePrerelease ? true : !v.prerelease) && !v.draft)[0]
            return Response.json(filtered)
        }
    }
    if (parsed.pathname.endsWith('/afdian-badge')) {
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
