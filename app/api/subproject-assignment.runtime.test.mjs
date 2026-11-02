import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = await mkdtemp(join(tmpdir(), "pi-web-subproject-route-"));
const project = join(root, "project");
const sessions = join(root, "agent", "sessions");
await mkdir(project, { recursive: true });
await mkdir(sessions, { recursive: true });
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.PI_WEB_SUBPROJECTS_FILE = join(root, "subprojects.json");
process.env.PI_WEB_DEVICE_ID = "subproject-route-test";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { PATCH } = await jiti.import("./sessions/[id]/subproject/route.ts");
const { createSubproject, readSubprojectState, resetSubprojectStateForTests } = await jiti.import("../../lib/subproject-state.ts");
const { persistSessionFile } = await jiti.import("../../lib/rpc-manager.ts");

test.after(async () => {
  globalThis.__piSessions = undefined;
  resetSubprojectStateForTests();
  await rm(root, { recursive: true, force: true });
});

async function assignLiveSession({ content, projectPath = project, sessionsPath = sessions, body: requestBody, label = "pi-web Reader", seedMessage = true } = {}) {
  const manager = SessionManager.create(projectPath, sessionsPath);
  const sessionId = manager.getSessionId();
  const sessionFile = manager.getSessionFile();
  if (seedMessage) manager.appendMessage({ role: "user", content, timestamp: Date.now() });
  const subproject = createSubproject(`path:${projectPath}`, label);
  let persistCalls = 0;
  globalThis.__piSessions = new Map([[sessionId, {
    isAlive: () => true,
    isRunning: () => false,
    cwd: projectPath,
    sessionFile,
    sessionId,
    inner: { sessionManager: manager },
    persistSessionFileNow: () => {
      persistCalls += 1;
      persistSessionFile(manager);
    },
  }]]);

  const response = await PATCH(
    new Request(`http://localhost/api/sessions/${encodeURIComponent(sessionId)}/subproject`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody ?? { subprojectId: subproject.id }),
    }),
    { params: Promise.resolve({ id: sessionId }) },
  );

  return { response, sessionFile, sessionId, subproject, persistCalls: () => persistCalls };
}

test("assigning a prompted live skill session persists it before transient validation", async () => {
  const result = await assignLiveSession({ content: "<skill name=code-review> repro" });
  const responseBody = await result.response.json();
  assert.equal(result.response.status, 200);
  assert.equal(result.persistCalls(), 1);
  assert.equal(existsSync(result.sessionFile), true);
  assert.equal(readSubprojectState().assignments.length, 1);
  assert.equal(responseBody.session.subprojectId, result.subproject.id);
  assert.deepEqual(responseBody.relatedSessionIds, [result.sessionId]);
  assert.match(await readFile(result.sessionFile, "utf8"), /<skill name=code-review>/);
});

test("malformed assignment input does not materialize a transient session", async () => {
  const result = await assignLiveSession({ content: "invalid assignment", body: {}, label: "invalid assignment", seedMessage: false });
  assert.equal(result.response.status, 400);
  assert.equal(result.persistCalls(), 0);
  assert.equal(existsSync(result.sessionFile), false);
  assert.equal(readSubprojectState().assignments.some((item) => item.sessionId === result.sessionId), false);
});

test("the same live-session boundary is independent of ordinary user text", async () => {
  const plainProject = join(root, "plain-project");
  const plainSessions = join(root, "plain-agent", "sessions");
  await mkdir(plainProject, { recursive: true });
  await mkdir(plainSessions, { recursive: true });
  const result = await assignLiveSession({ content: "plain prompt", projectPath: plainProject, sessionsPath: plainSessions });
  assert.equal(result.response.status, 200);
  assert.equal(result.persistCalls(), 1);
  assert.equal((await result.response.json()).session.subprojectId, result.subproject.id);
});
