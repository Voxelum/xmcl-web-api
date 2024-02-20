import { defineApi } from '../type.ts'
import { gte, lt } from "https://deno.land/std@0.178.0/semver/mod.ts"
import { Status } from "https://deno.land/x/oak@v11.1.0/mod.ts";

interface GithubReleaseItem {
  tag_name: string;
  prerelease: boolean;
  body: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
  }>;
  draft: boolean;
}

export default defineApi((router) =>
  router.get("/latest", async (ctx) => {
    const request = ctx.request;
    const includePrerelease = request.url.searchParams.has("prerelease");
    const response = await fetch(
      "https://api.github.com/repos/voxelum/x-minecraft-launcher/releases?per_page=10",
      {
        headers: {
          "Accept": "application/vnd.github.v3+json",
          "Authorization": `token ${Deno.env.get("GITHUB_PAT")}`,
        },
      },
    );

    const langs = request.headers.get("Accept-Language");

    let lang = "";
    if (langs) {
      const langItems = langs.split(";");
      for (const item of langItems) {
        if (item.indexOf("zh") !== -1) {
          lang = "zh";
          break;
        } else if (item.indexOf("en") !== -1) {
          lang = "en";
          break;
        }
      }
    }

    const version = request.url.searchParams.get("version");
    const releases: GithubReleaseItem[] = await response.json();
    if (version) {
      const filtered = releases.filter((r) =>
        gte(r.tag_name.substring(1), version) && !r.draft
      );
      const latest = filtered[0];
      if (!latest) {
        ctx.throw(Status.NotFound);
      }
      if (lt(version, "0.30.0")) {
        // Upgrade electron version
        latest.assets = latest.assets.filter((r) => !r.name.endsWith("asar"));
      }
      if (lt(version, "0.38.0")) {
        // Upgrade electron version to >= 25
        latest.assets = latest.assets.filter((r) => !r.name.endsWith("asar"));
      }
      // reset body
      const changelogs: string[] = [];

      for (const r of filtered) {
        const v = r.tag_name.startsWith("v")
          ? r.tag_name.substring(1)
          : r.tag_name;
        if (lang) {
          try {
            const response = await fetch(
              `https://raw.githubusercontent.com/voxelum/xmcl-page/master/src/${lang}/changelogs/${v}.md`,
            );
            const markdown = await response.text();
            const content = markdown.substring(markdown.lastIndexOf("---") + 4);
            changelogs.push(content);
          } catch {
            changelogs.push(r.body);
          }
        } else {
          changelogs.push(r.body);
        }
      }

      // Hint Winodws appx user won't have update soon and suggest user to use zip
      // The reason is the code sign certificate is outdated for appx and developer team need to renew it
      if (lt(version, "0.40.0")) {
        if (lang === 'zh') {
          changelogs.unshift(
            `# 注意 (Windows 用户)`,
            `如果您是通过 Appx 或 AppInstaller 安装的启动器，请注意：`,
            `由于证书过期，您将不会很快收到最新更新。建议您下载 zip 包并手动安装。`,
            `点击[这个链接](https://docs.xmcl.app/zh/guide/appx-migrate)查看如何迁移数据。`,
          )
        } else {
          changelogs.unshift(
            `# Notice (Windows User)`,
            `If you installed the launcher via Appx or AppInstaller, please be aware:`,
            `You won't receive the latest updates soon due to the certificate expiration. It's suggested to download the zip package and install it manually.`,
            `Click [this link](https://docs.xmcl.app/en/guide/appx-migrate) to see how to migrate your data.`,
          )
        }
      }

      latest.body = changelogs.join("\n\n");

      ctx.response.body = latest;
    } else {
      const filtered = releases.filter((v) =>
        (includePrerelease ? true : !v.prerelease) && !v.draft
      )[0];
      ctx.response.body = filtered;
    }
  })
);
