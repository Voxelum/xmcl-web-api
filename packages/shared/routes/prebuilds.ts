import { Hono } from "hono";
import { getConfig } from "../config.ts";
import { proxyResponse } from "../proxy.ts";
import type { AppEnv } from "../types.ts";

export type WorkflowRun = {
  name: string;
  display_title: string;
  status: string;
  created_at: string;
  run_number: number;
  id: number;
};

const WORKFLOW_RUNS_URL =
  "https://api.github.com/repos/voxelum/x-minecraft-launcher/actions/workflows/1220495/runs";

async function getRuns(token: string): Promise<WorkflowRun[]> {
  const runResponse = await fetch(WORKFLOW_RUNS_URL, {
    headers: token ? { Authorization: `token ${token}` } : {},
  });
  const data = (await runResponse.json()) as { workflow_runs: WorkflowRun[] };
  return data.workflow_runs
    .filter((r) => r.status !== "in_progress")
    .sort((a, b) => (a.created_at > b.created_at ? -1 : 1));
}

const route = new Hono<AppEnv>();

route.get("/prebuilds", async (c) => {
  const token = getConfig(c).GITHUB_PAT;
  if (!token) {
    return c.json([]);
  }
  return c.json(await getRuns(token));
});

route.get("/prebuilds/:id", async (c) => {
  const token = getConfig(c).GITHUB_PAT;
  const id = c.req.param("id");
  const upstream = await fetch(
    `https://api.github.com/repos/voxelum/x-minecraft-launcher/actions/runs/${id}/artifacts`,
    { headers: token ? { Authorization: `token ${token}` } : {} },
  );
  return proxyResponse(upstream);
});

export default route;
