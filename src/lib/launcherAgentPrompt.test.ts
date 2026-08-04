import assert from "node:assert/strict";
import {
  buildLauncherAgentSystemPrompt,
  parseLauncherAgentRequestContext,
} from "./launcherAgentPrompt.ts";

function launcherContext() {
  return {
    promptVersion: 1,
    agentType: "launcher",
    locale: "zh-CN",
    documents: [{
      id: "instance-management",
      description: "Manage an XMCL instance.",
    }],
    sessionContext: {
      instancePath: "C:\\XMCL\\instances\\fabric",
      instanceName: "Fabric",
      runtime: { minecraft: "1.21.1", fabricLoader: "0.16.10" },
      userId: "user-1",
      page: "/mods",
    },
  };
}

Deno.test("launcher prompt validates and reconstructs current capabilities", () => {
  const context = parseLauncherAgentRequestContext(launcherContext());
  assert.ok(context);
  const prompt = buildLauncherAgentSystemPrompt(context, [
    "vfs_shell",
    "vfs_read",
    "vfs_write",
    "ui",
  ]);
  assert.match(prompt, /primary XMCL \(X Minecraft Launcher\) assistant/);
  assert.match(prompt, /Reply in zh-CN/);
  assert.match(prompt, /Instance path: C:\\XMCL\\instances\\fabric/);
  assert.match(prompt, /Instance name: Fabric/);
  assert.match(prompt, /Minecraft: 1\.21\.1/);
  assert.match(prompt, /Fabric Loader: 0\.16\.10/);
  assert.match(prompt, /Available tools: vfs_shell, vfs_read, vfs_write, ui/);
  assert.match(prompt, /Built-in documents/);
  assert.match(prompt, /Do not change the selected instance or account/);
  assert.match(prompt, /Before `vfs_write`/);
});

Deno.test("CSS and modpack prompts use isolated server-owned roles", () => {
  const css = parseLauncherAgentRequestContext({
    promptVersion: 1,
    agentType: "css",
    locale: "en",
    sessionContext: { scope: "global" },
  });
  assert.ok(css);
  assert.match(
    buildLauncherAgentSystemPrompt(css, ["ui"]),
    /only responsibility is inspecting the launcher UI/,
  );

  const modpack = parseLauncherAgentRequestContext({
    promptVersion: 1,
    agentType: "modpack-changelog",
    locale: "en",
    sessionContext: { releaseContext: "Added Sodium 1.2.3." },
  });
  assert.ok(modpack);
  const prompt = buildLauncherAgentSystemPrompt(modpack, [
    "propose_modpack_release",
  ]);
  assert.match(prompt, /release-notes writer/);
  assert.match(prompt, /Added Sodium 1\.2\.3/);
  assert.match(prompt, /MUST finish by calling the provided tool exactly once/);
});

Deno.test("compaction uses its dedicated prompt and no session context", () => {
  const context = parseLauncherAgentRequestContext({
    promptVersion: 1,
    agentType: "compaction",
    locale: "en",
  });
  assert.ok(context);
  assert.equal(
    buildLauncherAgentSystemPrompt(context, []),
    "You summarize conversation context for another agent. Do not continue the conversation or answer its questions. Return only a concise checkpoint summary.",
  );
});

Deno.test("launcher prompt rejects unsupported versions and malformed context", () => {
  assert.equal(
    parseLauncherAgentRequestContext({
      ...launcherContext(),
      promptVersion: 2,
    }),
    undefined,
  );
  assert.equal(
    parseLauncherAgentRequestContext({
      ...launcherContext(),
      locale: "not a locale!",
    }),
    undefined,
  );
  assert.equal(
    parseLauncherAgentRequestContext({
      ...launcherContext(),
      sessionContext: {
        ...launcherContext().sessionContext,
        runtime: { minecraft: 121 },
      },
    }),
    undefined,
  );
});
