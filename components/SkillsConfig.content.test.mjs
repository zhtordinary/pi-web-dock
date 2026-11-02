import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SkillsConfig.tsx", import.meta.url), "utf8");

test("skill content requests keep peer and panel identity fields", () => {
  assert.match(source, /apiFor\(request\.identity\.remotePeer/);
  assert.match(source, /skills\/content\?/);
  assert.match(source, /scope: request\.identity\.viewScope/);
  assert.match(source, /sourceSessionId: sessionId \?\? null/);
  assert.match(source, /params\.set\("sessionId", request\.identity\.sourceSessionId\)/);
  assert.match(source, /revision: String\(request\.identity\.revision\)/);
  assert.match(source, /generation: String\(request\.generation\)/);
  assert.match(source, /params\.set\("trustKey", request\.identity\.trustKey\)/);
});

test("skill content response handling is abortable and drops stale panel responses", () => {
  assert.match(source, /const controller = new AbortController\(\)/);
  assert.match(source, /signal: controller\.signal/);
  assert.match(source, /controller\.signal\.aborted \|\| !isCurrentPanelRequest\(request\)/);
  assert.match(source, /return \(\) => controller\.abort\(\)/);
  assert.match(source, /parseSkillContent\(contentState\.content\)/);
  assert.match(source, /<FrontmatterCard data=\{contentParts\.frontmatter\} \/>/);
  assert.match(source, /<MarkdownBody/);
});

test("skill detail displays description through instructions frontmatter only", () => {
  const detail = source.slice(source.indexOf("function SkillDetail("), source.indexOf("export function SkillsConfig("));
  assert.ok(!detail.includes("{skill.description}"));
  assert.ok(!detail.includes(">Description</div>"));
  assert.ok(detail.includes("<FrontmatterCard data={contentParts.frontmatter} />"));
});

test("identity changes cover source session, remote peer, revision and trust", () => {
  const identity = {
    cwd: "/repo",
    viewScope: "project",
    remotePeer: "debian",
    sourceSessionId: "session-a",
    revision: 3,
    trustKey: "trusted",
  };
  const request = { identity, generation: 5 };
  const same = (left, right, generation) => left.cwd === right.cwd
    && left.viewScope === right.viewScope
    && left.remotePeer === right.remotePeer
    && (left.sourceSessionId ?? null) === (right.sourceSessionId ?? null)
    && left.revision === right.revision
    && left.trustKey === right.trustKey
    && request.generation === generation;
  assert.equal(same(identity, identity, 5), true);
  for (const changed of [
    { remotePeer: "air" },
    { sourceSessionId: "session-b" },
    { revision: 4 },
    { trustKey: "untrusted" },
  ]) {
    assert.equal(same(identity, { ...identity, ...changed }, 5), false);
  }
  assert.equal(same(identity, identity, 6), false);
});
