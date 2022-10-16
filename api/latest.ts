import { defineApi } from '../type.ts'
import { gte } from "https://deno.land/x/semver@v1.4.0/mod.ts"

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

export default defineApi(async (req, parsed) => {
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
})