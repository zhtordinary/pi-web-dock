import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildRuntimeInspection } from "./runtime-inspection.ts";

const source = (scope = "user", origin = "top-level", path = "/home/test/source") => ({
  path,
  source: "test-source",
  scope,
  origin,
});

function makeInner(systemPrompt) {
  return {
    sessionId: "runtime-test-session",
    sessionManager: { getCwd: () => "/home/test/project" },
    agent: { state: { systemPrompt } },
    getActiveToolNames: () => ["read"],
    getAllTools: () => [
      {
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        promptGuidelines: ["Show file paths"],
        sourceInfo: source(),
      },
      {
        name: "hidden_tool",
        description: "Not included in the prompt snippet",
        parameters: { type: "object" },
        promptGuidelines: [],
        sourceInfo: source("project", "package", "/home/test/pkg/ext.ts"),
      },
    ],
    resourceLoader: {
      getSkills: () => ({ skills: [
        {
          name: "visible-skill",
          description: "Visible skill",
          filePath: "/home/test/skills/visible/SKILL.md",
          baseDir: "/home/test/skills/visible",
          disableModelInvocation: false,
          sourceInfo: source("user", "top-level", "/home/test/skills/visible/SKILL.md"),
        },
        {
          name: "dormant-skill",
          description: "Dormant skill",
          filePath: "/home/test/skills/dormant/SKILL.md",
          baseDir: "/home/test/skills/dormant",
          disableModelInvocation: true,
          sourceInfo: source("user", "top-level", "/home/test/skills/dormant/SKILL.md"),
        },
      ] }),
      getExtensions: () => ({
        extensions: [{
          path: "/home/test/pkg/ext.ts",
          resolvedPath: "/home/test/pkg/ext.ts",
          sourceInfo: source("project", "package", "/home/test/pkg/ext.ts"),
          tools: new Map([["hidden_tool", {}]]),
          commands: new Map([["inspect", {}]]),
        }],
        errors: [{ path: "/home/test/broken.ts", error: "syntax error" }],
      }),
      getAgentsFiles: () => ({ agentsFiles: [{ path: "/home/test/AGENTS.md", content: "Rules" }] }),
      getSystemPrompt: () => "Base prompt",
      getSystemPromptSource: () => ({ path: "/home/test/system.md" }),
      getAppendSystemPrompt: () => ["Appended prompt"],
      getAppendSystemPromptSources: () => [{ path: "/home/test/append.md" }],
    },
  };
}

const prompt = `Base prompt\n\n<project_context>\n<project_instructions path="/home/test/AGENTS.md">\nRules\n</project_instructions>\n</project_context>\n\nAvailable tools:\n- read: Read a file\n\n<available_skills>\n  <skill>\n    <name>visible-skill</name>\n    <description>Visible skill</description>\n    <location>/home/test/skills/visible/SKILL.md</location>\n  </skill>\n</available_skills>\n\nAppended prompt`;

test("buildRuntimeInspection uses the exact runtime prompt and resource loader evidence", () => {
  const result = buildRuntimeInspection(makeInner(prompt), "2026-01-01T00:00:00.000Z", prompt);

  assert.equal(result.evidence.basis, "agent-session-runtime");
  assert.equal(result.sessionId, "runtime-test-session");
  assert.equal(result.cwd, "/home/test/project");
  assert.equal(result.evidence.systemPromptSource, "agent.state.systemPrompt");
  assert.equal(result.evidence.providerRequestCaptured, false);
  assert.equal(result.capturedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(result.snapshotId, `2026-01-01T00:00:00.000Z:${result.systemPrompt.sha256.slice(0, 16)}`);
  assert.equal(result.systemPrompt.characters, prompt.length);
  assert.equal(result.systemPrompt.lines, prompt.split("\n").length);
  assert.equal(result.systemPrompt.estimatedTokens, Math.ceil(prompt.length / 4));

  const agentFile = result.contextSources.find((item) => item.path === "/home/test/AGENTS.md");
  assert.equal(agentFile?.inSystemPrompt, true);
  assert.deepEqual(agentFile?.promptRange?.startLine, 4);
  assert.equal(result.contextSources.find((item) => item.path === "/home/test/append.md")?.inSystemPrompt, true);

  const visibleSkill = result.skills.find((item) => item.name === "visible-skill");
  const dormantSkill = result.skills.find((item) => item.name === "dormant-skill");
  assert.equal(visibleSkill?.promptVisible, true);
  assert.equal(dormantSkill?.promptVisible, false);
  assert.equal(dormantSkill?.disableModelInvocation, true);

  const read = result.tools.find((item) => item.name === "read");
  const hidden = result.tools.find((item) => item.name === "hidden_tool");
  assert.equal(read?.active, true);
  assert.equal(read?.mentionedInSystemPrompt, true);
  assert.deepEqual(read?.parameters, { type: "object", properties: { path: { type: "string" } } });
  assert.equal(hidden?.active, false);
  assert.equal(hidden?.mentionedInSystemPrompt, false);

  const loaded = result.extensions.find((item) => item.status === "loaded");
  const failed = result.extensions.find((item) => item.status === "failed");
  assert.deepEqual(loaded?.registeredTools, ["hidden_tool"]);
  assert.deepEqual(loaded?.registeredCommands, ["inspect"]);
  assert.equal(failed?.error, "syntax error");
  assert.deepEqual(result.errors, []);
});

test("inspection follows the supplied live prompt instead of a different configuration-shaped string", () => {
  const runtimePrompt = "runtime B\n- read: Read a file";
  const result = buildRuntimeInspection(makeInner("configuration A"), "2026-01-01T00:00:00.000Z", runtimePrompt);
  assert.equal(result.systemPrompt.characters, runtimePrompt.length);
  assert.equal(result.tools.find((item) => item.name === "read")?.mentionedInSystemPrompt, true);
  assert.equal(result.tools.find((item) => item.name === "hidden_tool")?.mentionedInSystemPrompt, false);
});

test("inspection records local skill baseline and dynamic observations without provider claims", () => {
  const runtimePrompt = "stable baseline";
  const skillRuntime = {
    baseline: {
      sha256: "baseline-sha",
      characters: runtimePrompt.length,
      estimatedTokens: Math.ceil(runtimePrompt.length / 4),
    },
    last: {
      status: "settled",
      skillName: "visible-skill",
      policyKey: "top-level:~/skills/visible/SKILL.md",
      bodySha256: "body-sha",
      baselineBefore: {
        sha256: "baseline-sha",
        characters: runtimePrompt.length,
        estimatedTokens: Math.ceil(runtimePrompt.length / 4),
      },
      baselineAfter: {
        sha256: "baseline-sha",
        characters: runtimePrompt.length,
        estimatedTokens: Math.ceil(runtimePrompt.length / 4),
      },
      baselineUnchanged: true,
      observedAt: "2026-01-01T00:00:00.000Z",
    },
    activeCount: 0,
  };
  const result = buildRuntimeInspection(makeInner(runtimePrompt), "2026-01-01T00:00:00.000Z", runtimePrompt, skillRuntime);
  assert.deepEqual(result.skillRuntime, skillRuntime);
  assert.equal(result.evidence.providerRequestCaptured, false);
  assert.match(result.evidence.note, /providerRequestCaptured=false/);
});


test("get_state passes the same live prompt into the runtime inspection builder", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const stateSource = source.slice(source.indexOf('case "get_state"'), source.indexOf('case "set_model"'));
  assert.match(stateSource, /const systemPrompt = this\.inner\.agent\.state\?\.systemPrompt \?\? "";/);
  assert.match(stateSource, /const skillRuntimeEvidence = this\.skillRuntimeTracker\.snapshot\(liveSystemPrompt\);/);
  assert.match(stateSource, /if \(command\.systemPrompt !== false\)/);
  assert.match(stateSource, /buildRuntimeInspection\(this\.inner, undefined, liveSystemPrompt, skillRuntimeEvidence\)/);
  assert.match(stateSource, /promptState = \{ systemPrompt: liveSystemPrompt, runtimeInspection \}/);
  assert.match(stateSource, /estimateSystemPromptCost/);
  assert.match(stateSource, /estimatedInputCost/);
});
