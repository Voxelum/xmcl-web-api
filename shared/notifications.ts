export interface Notification {
  created_at: Date
  updated_at: Date
  id: string
  title: string
  body: string
  tags: string[]
}

export async function getNofications(os: string | null, arch: string | null, env: string | null, locale: string | null, version: string | null, pat: string | undefined, {
  inRange
}: {
  inRange: (version: string, range: string) => boolean,
}) {
  const labels = `os:${os || ''},arch:${arch || ''},env:${env || ''},l:${locale || ''}`;

  const response = await fetch(
    `https://api.github.com/repos/voxelum/xmcl-static-resource/issues?labels=${labels}&per_page=5&creator=ci010`,
    {
      headers: {
        "Accept": "application/vnd.github.v3+json",
        "Authorization": `token ${pat}`,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch notifications: ${response.statusText}`);
  }

  function parseLabels(label: { name: string }[]) {
    const tags = label.filter(l => l.name.startsWith('t:')).map(l => l.name.substring(2));
    const versionCriteria = label.filter(l => l.name.startsWith('v:')).map(l => l.name.substring(2))[0];
    if (versionCriteria && version) {
      if (!inRange(version, versionCriteria)) {
        return false
      }
    }
    return tags
  }
  const issues: any[] = await response.json();
  const notifications: Notification[] = issues.map((issue) => {
    const tags = parseLabels(issue.labels);
    if (tags) {
      return {
        created_at: new Date(issue.created_at),
        updated_at: new Date(issue.updated_at),
        tags,
        id: issue.id,
        title: issue.title,
        body: issue.body,
      }
    }
    return undefined
  }).filter((issue) => issue !== undefined) as Notification[];

  return notifications;
}