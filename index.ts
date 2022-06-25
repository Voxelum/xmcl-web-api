import { serve } from "https://deno.land/std@0.142.0/http/server.ts";

interface GithubReleaseItem {
    tag_name: string
    prerelease: boolean
    assets: Array<{
        name: string
        browser_download_url: string
    }>
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
        const releases: GithubReleaseItem[] = await response.json()
        const filtered = releases.filter(v => includePrerelease ? true : !v.prerelease)[0]
        return Response.json(filtered)
    }
    return Response.json({ error: 'Not Found' }, { status: 404 })
});
