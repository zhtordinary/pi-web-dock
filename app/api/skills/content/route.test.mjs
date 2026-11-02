import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const root = await mkdtemp(join(tmpdir(), "pi-web-skill-content-"));
const agentDir = join(root, "agent");
const skillsDir = join(agentDir, "skills");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousPolicy = process.env.PI_WEB_FILE_PERMISSIONS_FILE;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_WEB_FILE_PERMISSIONS_FILE = join(root, "permissions.json");

const skillPath = join(skillsDir, "preview", "SKILL.md");
const skillContent = "---\nname: preview\ndescription: Preview skill\n---\n\n# Preview\n\n- formatted\n";
const disabledSkillPath = join(skillsDir, "manual", "SKILL.md");
const disabledSkillContent = "---\nname: manual\ndescription: Manual skill\ndisable-model-invocation: true\n---\n\n# Manual\n\n- still viewable\n";
const escapedSkillTarget = join(root, "escaped-skill");
const escapedSkillPath = join(skillsDir, "escaped", "SKILL.md");
const escapedSkillContent = "---\nname: escaped\ndescription: Escaped skill\n---\n\n# Escaped\n";
await mkdir(join(skillsDir, "preview"), { recursive: true });
await writeFile(skillPath, skillContent);
await mkdir(join(skillsDir, "manual"), { recursive: true });
await writeFile(disabledSkillPath, disabledSkillContent);
await mkdir(escapedSkillTarget, { recursive: true });
await writeFile(join(escapedSkillTarget, "SKILL.md"), escapedSkillContent);
await symlink(escapedSkillTarget, join(skillsDir, "escaped"), "dir");

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { allowFileRoot } = await jiti.import("../../../../lib/file-access.ts");
allowFileRoot(process.cwd());
allowFileRoot(agentDir);
const { GET } = await jiti.import("./route.ts");

after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousPolicy === undefined) delete process.env.PI_WEB_FILE_PERMISSIONS_FILE;
  else process.env.PI_WEB_FILE_PERMISSIONS_FILE = previousPolicy;
  await rm(root, { recursive: true, force: true });
});

function getContent(filePath, options = {}) {
  const url = new URL("http://localhost/api/skills/content");
  url.searchParams.set("cwd", options.cwd ?? process.cwd());
  url.searchParams.set("filePath", filePath);
  url.searchParams.set("scope", options.scope ?? "global");
  if (options.sessionId) url.searchParams.set("sessionId", options.sessionId);
  if (options.revision !== undefined) url.searchParams.set("revision", String(options.revision));
  if (options.trustKey) url.searchParams.set("trustKey", options.trustKey);
  if (options.generation !== undefined) url.searchParams.set("generation", String(options.generation));
  return GET(new Request(url, { headers: { host: "localhost" } }));
}

test("returns the complete file for a skill loaded by the selected resource scope", async () => {
  const response = await getContent(skillPath, {
    sessionId: "source-session",
    revision: 4,
    trustKey: "trusted",
    generation: 7,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { content: skillContent });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("allows viewing a loaded skill whose invocation is disabled", async () => {
  const response = await getContent(disabledSkillPath);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { content: disabledSkillContent });
});

test("rejects a loaded symlink whose physical target escapes skill resource roots", async () => {
  const response = await getContent(escapedSkillPath);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Access denied" });
});

test("refuses a Markdown file that is not a loaded skill", async () => {
  const outsidePath = join(root, "outside.md");
  await writeFile(outsidePath, "# not a skill\n");

  const response = await getContent(outsidePath);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Skill not found" });
});

test("rejects a loaded skill that exceeds the one-MiB response cap", async () => {
  const hugePath = join(skillsDir, "huge", "SKILL.md");
  await mkdir(join(skillsDir, "huge"), { recursive: true });
  await writeFile(hugePath, `---\nname: huge\ndescription: Huge skill\n---\n${"x".repeat(1024 * 1024)}`);
  try {
    const response = await getContent(hugePath);
    assert.equal(response.status, 413);
    assert.match((await response.json()).error, /larger than 1048576 bytes/);
  } finally {
    await rm(join(skillsDir, "huge"), { recursive: true, force: true });
  }
});

test("requires both the working directory and skill path", async () => {
  const withoutCwd = await GET(new Request(`http://localhost/api/skills/content?filePath=${encodeURIComponent(skillPath)}`, { headers: { host: "localhost" } }));
  const withoutFile = await GET(new Request(`http://localhost/api/skills/content?cwd=${encodeURIComponent(process.cwd())}`, { headers: { host: "localhost" } }));
  assert.equal(withoutCwd.status, 400);
  assert.equal(withoutFile.status, 400);
});

test("rejects an unknown resource scope", async () => {
  const url = new URL("http://localhost/api/skills/content");
  url.searchParams.set("cwd", process.cwd());
  url.searchParams.set("filePath", skillPath);
  url.searchParams.set("scope", "temporary");
  const response = await GET(new Request(url, { headers: { host: "localhost" } }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "scope must be global or project" });
});

test("rejects an untrusted API host before loading resources", async () => {
  const url = new URL("http://evil.example/api/skills/content");
  url.searchParams.set("cwd", process.cwd());
  url.searchParams.set("filePath", skillPath);
  const response = await GET(new Request(url, { headers: { host: "evil.example" } }));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Untrusted API request" });
});

test("keeps route-level regular-file and one-MiB checks explicit", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("./route.ts", import.meta.url), "utf8");
  assert.match(source, /readRegularFileText\(loadedPath, SKILL_CONTENT_MAX_BYTES\)/);
  assert.match(source, /not a regular file/);
  assert.match(source, /larger than \\d\+ bytes/);
  assert.match(source, /isExistingFilePathAllowed\(requestedFilePath, resourceRoots\)/);
  assert.match(source, /loadSkillsWithInstallInfo\(cwd, scope\)/);
});
