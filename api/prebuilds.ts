import { Router } from "oak";

export type WorkflowRun = {
  name: string;
  display_title: string
  status: string;
  created_at: string;
  run_number: number;
  id: number;
  // Add more properties as needed
};

export async function getRuns(token: string): Promise<WorkflowRun[]> {
  const runResponse = await fetch(`https://api.github.com/repos/voxelum/x-minecraft-launcher/actions/workflows/1220495/runs`, {
    headers: token ? {
      Authorization: `token ${token}`,
    } : {},
  });
  return processData(await runResponse.json() as any)
}

const processData = (data: { workflow_runs: WorkflowRun[] }) => {
  return data.workflow_runs.filter(r => r.status !== 'in_progress').sort((a, b) => a.created_at > b.created_at ? -1 : 1);
}

export default new Router().get("/prebuilds", async (ctx) => {
  const token = Deno.env.get('GITHUB_PAT')

  if (token) {
    const runs = await getRuns(token)
    ctx.response.body = runs;
  } else {
    ctx.response.body = [];
  }
}).get("/prebuilds/:id", async (ctx) => {
  const token = Deno.env.get('GITHUB_PAT')
  const id = ctx.params.id

  const resp = await fetch(`https://api.github.com/repos/voxelum/x-minecraft-launcher/actions/runs/${id}/artifacts`, {
    headers: token ? {
      Authorization: `token ${token}`,
    } : {},
  })

  ctx.response.body = resp.body

  resp.headers.forEach((value, key) => {
    ctx.response.headers.set(key, value)
  })
  ctx.response.status = resp.status
})