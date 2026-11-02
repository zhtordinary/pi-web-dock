import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { parseSkillCommand } = await jiti.import("../lib/skill-runtime-policy.ts");
const appSource = readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");
const inputSource = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const handlerStart = appSource.indexOf("  const handleChatInputReady =");
const handlerEnd = appSource.indexOf("  // Same @mention format", handlerStart);
const prependStart = inputSource.indexOf("    prependText(text:");
const prependEnd = inputSource.indexOf("    rekeyDraft(", prependStart);
assert.ok(handlerStart > 0 && handlerEnd > handlerStart && prependStart > 0 && prependEnd > prependStart);

function composer(draft) {
  const images = [{ data: "existing-image", mimeType: "image/png" }];
  const ctx = {
    value: draft, valueRef: { current: draft }, textareaRef: { current: { value: draft } },
    pendingDraftFocusRef: { current: null }, draftKey: "fixture-draft", images,
    setValue(value) { ctx.value = value; ctx.textareaRef.current.value = value; },
    setAttachedImages() { assert.fail("inserting a Skill must preserve existing attachments"); },
    setAtQuery() {},
  };
  runInNewContext(stripTypeScriptTypes(`globalThis.handle = {${inputSource.slice(prependStart, prependEnd)}};`), ctx);
  return ctx;
}

function shell(input, mode = "local") {
  const frames = [], listeners = {}, parent = {};
  const ctx = {
    chatInputRef: { current: mode === "local" ? input.handle : null },
    pendingEmbeddedSkillRef: { current: null }, embeddedIframeRef: { current: null },
    embeddedIframeReadyRef: { current: false }, embeddedReaderUrl: null,
    selectedSession: null, remoteSession: null, newSessionCwd: "/fixture/project", activeCwdRef: { current: "/fixture/project" },
    EMBEDDED_INSERT_SKILL_EVENT: "pi-web:insert-skill",
    useCallback: callback => callback, useEffect: callback => callback(),
    requestAnimationFrame: callback => frames.push(callback), setSettingsModalTab() {},
    setNewSessionCwd(cwd) { assert.equal(cwd, "/fixture/project"); ctx.chatInputRef.current = input.handle; },
    window: { parent, addEventListener(name, listener) { listeners[name] = listener; }, removeEventListener() {} },
  };
  runInNewContext(stripTypeScriptTypes(`${appSource.slice(handlerStart, handlerEnd)}
globalThis.useSkill = handleUseSkill; globalThis.inputReady = handleChatInputReady;`), ctx);
  return {
    ctx,
    receive(data, source = parent) { listeners.message({ data, source }); },
    flush() {
      for (let count = 0; frames.length; count++) {
        assert.ok(count < 40, "Skill insertion must settle without an endless retry");
        frames.shift()();
      }
    },
  };
}

const skillName = "photo-to-travel-journal-watercolor";
for (const mode of ["local", "new-session", "embedded-ready", "embedded-pending"]) {
  test(`Skill button keeps the SDK space delimiter and original draft through ${mode}`, () => {
    for (const draft of ["第一行\n第二行", "请根据这张照片绘制旅行手账", "", "\n  原始正文\n末行  "]) {
      const input = composer(draft), originalImages = input.images;
      const parent = shell(input, mode === "local" ? "local" : "new-session");
      let child, sent;
      if (mode.startsWith("embedded")) {
        child = shell(input);
        parent.ctx.embeddedReaderUrl = "https://reader.example/";
        parent.ctx.embeddedIframeReadyRef.current = true;
        if (mode === "embedded-pending") child.ctx.chatInputRef.current = null;
        parent.ctx.embeddedIframeRef.current = { contentWindow: { postMessage(data) { sent = data; child.receive(data); } } };
      }
      parent.ctx.useSkill(skillName);
      parent.flush();
      if (mode === "embedded-pending") {
        assert.equal(input.value, draft);
        child.ctx.chatInputRef.current = input.handle;
        child.ctx.inputReady();
        assert.equal(child.ctx.pendingEmbeddedSkillRef.current, null);
      }
      if (child) {
        assert.equal(sent.type, "pi-web:insert-skill");
        const before = input.value;
        child.receive(sent, {});
        assert.equal(input.value, before, "a non-parent message must not insert another command");
      }
      assert.deepEqual(parseSkillCommand(input.value.trim()), { name: skillName, args: draft.trim() });
      if (sent) assert.equal(sent.command, `/skill:${skillName} `);
      const expected = draft.trim() ? `/skill:${skillName} \n\n${draft}` : `/skill:${skillName} `;
      assert.equal(input.value, expected);
      assert.equal(input.valueRef.current, expected);
      assert.equal(input.pendingDraftFocusRef.current.value, expected);
      assert.equal(input.images, originalImages);
      if (!draft) assert.deepEqual(parseSkillCommand(`${input.value}继续输入需求`), { name: skillName, args: "继续输入需求" });
    }
  });
}

test("ordinary prepended text retains its blank-line separation", () => {
  const input = composer("已有正文\n第二行");
  input.handle.prependText("恢复的普通文本");
  assert.equal(input.value, "恢复的普通文本\n\n已有正文\n第二行");
  assert.equal(parseSkillCommand(input.value), null);
});
