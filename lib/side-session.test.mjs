import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { createSideSession, forkSessionBranch, promoteSideSession, SessionForkError } = await jiti.import("./session-fork.ts");
const { readSideRelation, sideFirstMessageEntryId, sideOwnEntries, sideToolNames, sideUserMessageCount, SIDE_BOUNDARY_TEXT, SIDE_META_TYPE } = await jiti.import("./side-session.ts");
const { SIDE_BOUNDARY_MESSAGE_TYPE } = await jiti.import("./session-family.ts");
const { appendClearedSessionToolSelection, appendSessionToolSelection, readSessionToolSelectionPolicy } = await jiti.import("./session-tool-selection.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");

const user = (content) => ({ role: "user", content, timestamp: Date.now() });
const assistant = (content, usage) => ({
  role: "assistant",
  content: [{ type: "text", text: content }],
  timestamp: Date.now(),
  ...(usage ? { usage } : {}),
});
const readLines = async (path) => (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));

function usageTotals(entries) {
  return entries
    .filter((entry) => entry.type === "message" && entry.message?.role === "assistant" && entry.message.usage)
    .reduce((total, entry) => {
      const usage = entry.message.usage;
      for (const key of ["input", "cacheRead", "cacheWrite", "output"]) total[key] += usage[key] ?? 0;
      return total;
    }, { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
}

test("creates a hidden side session with an inherited boundary and refuses nesting", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-side-session-test-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousHome = process.env.HOME;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.HOME = join(root, "home");
  const cwd = join(root, "project");
  const sessionDir = join(root, "sessions");
  await mkdir(cwd, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });

  const source = SessionManager.create(cwd, sessionDir);
  source.appendMessage(user("question"));
  source.appendMessage(assistant("answer"));
  const before = await readFile(source.getSessionFile(), "utf8");
  const side = createSideSession(source.getSessionFile());
  const entries = await readLines(side.path);
  const metadata = entries[1];
  const boundary = entries.at(-1);

  assert.equal(await readFile(source.getSessionFile(), "utf8"), before);
  assert.equal(metadata.customType, SIDE_META_TYPE);
  assert.equal(readSideRelation(entries.slice(1, 3))?.parentSessionId, source.getSessionId());
  assert.equal(boundary.type, "custom_message");
  assert.equal(boundary.customType, SIDE_BOUNDARY_MESSAGE_TYPE);
  assert.equal(boundary.content, SIDE_BOUNDARY_TEXT);
  assert.equal(boundary.display, false);
  assert.equal(SessionManager.open(side.path).getLeafId(), boundary.id);
  assert.equal(sideFirstMessageEntryId(entries), null);
  assert.equal(sideUserMessageCount(entries), 0);

  const sideManager = SessionManager.open(side.path);
  sideManager.appendMessage(user("side question"));
  sideManager.appendMessage(assistant("side answer"));
  const afterPrompt = await readLines(side.path);
  assert.equal(sideFirstMessageEntryId(afterPrompt), afterPrompt.at(-2).id);
  assert.equal(sideUserMessageCount(afterPrompt), 1);
  assert.throws(() => createSideSession(side.path), (error) => error instanceof SessionForkError && error.code === "side");

  const promoted = promoteSideSession(side.path);
  const promotedEntries = await readLines(promoted.path);
  assert.notEqual(promoted.sessionId, side.sessionId);
  assert.equal(readSideRelation(promotedEntries), null);
  assert.equal(promotedEntries.some((entry) => entry.customType === SIDE_META_TYPE), false);
  assert.equal(promotedEntries.some((entry) => entry.customType === SIDE_BOUNDARY_MESSAGE_TYPE), false);
  assert.equal(promotedEntries.some((entry) => entry.id?.startsWith("side-tools-")), false);
  assert.ok(promotedEntries.some((entry) => entry.type === "message" && entry.message?.role === "user" && entry.message?.content === "side question"));
  assert.ok(SessionManager.open(promoted.path).getLeafId());
});

test("Fork, Side and promotion inherit the current strict policy even from an older branch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-side-strict-policy-"));
  const cwd = join(root, "project");
  const sessionDir = join(root, "sessions");
  await mkdir(cwd, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  const source = SessionManager.create(cwd, sessionDir);
  source.appendMessage(user("question"));
  appendSessionToolSelection(source, ["edit", "write"], { strict: true });
  const earlierLeaf = source.getLeafId();
  source.appendMessage(assistant("answer"));
  appendSessionToolSelection(source, ["read"], { strict: true });
  const policy = { tools: ["read"], strict: true };
  const fork = forkSessionBranch(source.getSessionFile(), earlierLeaf, null);
  const side = createSideSession(source.getSessionFile(), earlierLeaf);
  for (const path of [fork.path, side.path]) {
    assert.deepEqual(readSessionToolSelectionPolicy(await readLines(path)), policy);
  }
  const promoted = promoteSideSession(side.path);
  assert.deepEqual(readSessionToolSelectionPolicy(await readLines(promoted.path)), policy);

  appendClearedSessionToolSelection(source);
  const clearedFork = forkSessionBranch(source.getSessionFile(), earlierLeaf, null);
  assert.equal(readSessionToolSelectionPolicy(await readLines(clearedFork.path)), undefined);
});

test("keeps Side tools within the read-mostly parent intersection", () => {
  assert.deepEqual(sideToolNames(["read", "bash", "edit", "write"], []), ["read", "bash"]);
  assert.deepEqual(sideToolNames(["read", "mcp", "Agent"], []), ["read"]);
  assert.deepEqual(sideToolNames(undefined, []), ["read", "bash"]);
});

test("keeps inherited Fork and promotion usage while Side usage counts only its own entries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-side-usage-test-"));
  const cwd = join(root, "project");
  const sessionDir = join(root, "sessions");
  await mkdir(cwd, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  const inheritedUsage = { input: 10, cacheRead: 90, cacheWrite: 0, output: 2 };
  const sideUsage = { input: 3, cacheRead: 7, cacheWrite: 0, output: 1 };
  const source = SessionManager.create(cwd, sessionDir);
  source.appendMessage(user("inherited question"));
  source.appendMessage(assistant("inherited answer", inheritedUsage));
  const sourceEntries = await readLines(source.getSessionFile());
  const sourceTotal = usageTotals(sourceEntries);

  const fork = forkSessionBranch(source.getSessionFile(), undefined, null);
  assert.deepEqual(usageTotals(await readLines(fork.path)), sourceTotal);

  const side = createSideSession(source.getSessionFile());
  const sideManager = SessionManager.open(side.path);
  sideManager.appendMessage(user("side question"));
  sideManager.appendMessage(assistant("side answer", sideUsage));
  const sideEntries = await readLines(side.path);
  assert.deepEqual(usageTotals(sideOwnEntries(sideEntries)), sideUsage, JSON.stringify(sideOwnEntries(sideEntries)));
  assert.deepEqual(usageTotals(sideEntries), {
    input: inheritedUsage.input + sideUsage.input,
    cacheRead: inheritedUsage.cacheRead + sideUsage.cacheRead,
    cacheWrite: 0,
    output: inheritedUsage.output + sideUsage.output,
  });

  const promoted = promoteSideSession(side.path);
  assert.deepEqual(usageTotals(await readLines(promoted.path)), usageTotals(sideEntries));
});
