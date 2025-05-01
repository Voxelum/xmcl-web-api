import { app, HttpRequest } from 'npm:@azure/functions';
import geoip from 'npm:geoip-lite';
import { gte, lt, Range } from 'npm:semver';
import { getLatest, GithubReleaseItem } from "../shared/latest.ts";
import { getNofications } from "../shared/notifications.ts";

app.get('flights', (request: HttpRequest) => {
  const version = request.query?.get('version');
  const locale = request.query?.get('locale');
  const build = request.query?.get('build');

  if (!version || !locale) {
    return {
      headers: {
        'Content-Type': 'application/json',
      },
      jsonBody: {}
    }
  }
  if (build && Number(build) > 1002) {
    return {
      headers: {
        'Content-Type': 'application/json',
      },
      jsonBody: {
        i18nSearch: ['zh-CN']
      }
    };
  }
  return {
    headers: {
      'Content-Type': 'application/json',
    },
    jsonBody: {}
  }
})

app.get('latest', async (request: HttpRequest) => {
  const includePrerelease = request.query?.has("prerelease");
  const version = request.query?.get("version");
  const langs = request.headers.get("Accept-Language");

  const result = await getLatest(includePrerelease, version, langs, process.env.GITHUB_PAT, {
    gte,
    lt
  })

  return {
    jsonBody: result
  }
})

app.get('notifications', async (request: HttpRequest) => {
  const version = request.query?.get("version");
  const osRelease = request.query?.get("osRelease");
  const os = request.query?.get("os");
  const arch = request.query?.get("arch");
  const env = request.query?.get("env");
  const build = request.query?.get("build");
  const locale = request.query?.get("locale");
  const result = await getNofications(os, arch, env, locale, version, process.env.GITHUB_PAT, {
    inRange(version, range) {
      const r = new Range(range);
      return r.test(version);
    }
  })

  return {
    jsonBody: result
  }
})

app.get('zulu', async (request: HttpRequest) => {
  const response = await fetch('https://raw.githubusercontent.com/Voxelum/xmcl-static-resource/refs/heads/main/zulu.json', {
    headers: request.headers,
  })
  return {
    status: response.status,
    headers: response.headers,
    jsonBody: await response.json(),
  }
})


function isChineseIP(request: HttpRequest) {
  const ip = request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip");

  if (!ip) {
    return false;
  }

  const geo = geoip.lookup(ip);

  if (!geo) {
    return false;
  }

  const country = geo.country;
  if (!country) {
    return false;
  }

  return country === "CN";
}

app.get('appx', async (request: HttpRequest) => {
  const response = await fetch("https://api.github.com/repos/voxelum/x-minecraft-launcher/releases/latest", {
    headers: {
      "Accept": "application/vnd.github.v3+json",
      "Authorization": `token ${process.env.GITHUB_PAT}`,
    },
  })

  if (!response.ok) {
    return {
      status: response.status,
    }
  }

  const responseBody = await response.json() as GithubReleaseItem;
  const downloadUrl = responseBody.assets.find(a => a.name.endsWith(".appx"))?.browser_download_url

  if (isChineseIP(request)) {
    return {
      status: 302,
      headers: {
        "Location": downloadUrl,
        "Content-Type": "text/plain",
      },
    }
  }

  const proxies = [
    'https://gh-proxy.com',
    'https://gitproxy.click',
    'https://github.moeyy.xyz',
    'https://ghfile.geekertao.top',
    'https://github.proxy.class3.fun',
    'https://github-proxy.lixxing.top',
    'https://github.tbedu.top',
    'https://hub.gitmirror.com',
    'https://gh-proxy.net',
    'https://gh-proxy.cijhn.workers.dev',
  ]
  // randomly select a proxy
  const proxy = proxies[Math.floor(Math.random() * proxies.length)];

  return {
    status: 302,
    headers: {
      "Location": `${proxy}/${downloadUrl}`,
      "Content-Type": "text/plain",
    },
  }
})