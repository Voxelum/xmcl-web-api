export interface GithubReleaseItem {
  tag_name: string;
  prerelease: boolean;
  body: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
  }>;
  draft: boolean;
}

export async function getLatest(
  includePrerelease: boolean,
  version: string | null,
  langs: string | null,
  pat: string | undefined,
  { gte, lt }: {
    gte: (a: string, b: string) => boolean;
    lt: (a: string, b: string) => boolean;
  }
) {
  const response = await fetch(
    "https://api.github.com/repos/voxelum/x-minecraft-launcher/releases?per_page=5",
    {
      headers: {
        "Accept": "application/vnd.github.v3+json",
        "Authorization": `token ${pat}`,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch releases: ${response.statusText}`);
    // ctx.throw(Status.InternalServerError, "Failed to fetch releases");
  }

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

  const releases: GithubReleaseItem[] = await response.json();
  if (version) {
    let latest: GithubReleaseItem | undefined
    let recent: GithubReleaseItem[]
    if (version === 'v1.0.7') {
      // Strange user who is using v1.0.7. Not sure who is using this version and why.
      // We just gives the latest version for them
      latest = releases[0];
      recent = releases.slice(5);
    } else {
      recent = releases.filter((r) =>
        gte(r.tag_name.substring(1), version) && !r.draft
      );
      latest = recent[0];
    }
    if (!latest) {
      throw new Error('Cannot find the compatible version');
      // ctx.throw(Status.NotFound, 'Cannot find the compatible version');
    }
    if (lt(version, "0.30.0")) {
      // Upgrade electron version
      latest.assets = latest.assets.filter((r) => !r.name.endsWith("asar"));
    }
    if (lt(version, "0.38.0")) {
      // Upgrade electron version to >= 25
      latest.assets = latest.assets.filter((r) => !r.name.endsWith("asar"));
    }
    if (lt(version, "0.44.2")) {
      // Upgrade electron version to >= 30
      latest.assets = latest.assets.filter((r) => !r.name.endsWith("asar"));
    }
    // reset body
    const changelogs: string[] = [];

    for (const r of recent) {
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

    return latest
  }

  const filtered = releases.filter((v) =>
    (includePrerelease ? true : !v.prerelease) && !v.draft
  )[0];
  return filtered;
}