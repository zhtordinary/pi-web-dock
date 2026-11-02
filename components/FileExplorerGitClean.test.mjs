import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const explorerSource = await readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8");
const zhSource = await readFile(new URL("../lib/i18n/messages/zh-CN.ts", import.meta.url), "utf8");
const enSource = await readFile(new URL("../lib/i18n/messages/en.ts", import.meta.url), "utf8");

test("Git empty state and push affordance meet VSCode/Cursor standard", () => {
  // Clean working tree empty state assertions
  assert.match(explorerSource, /files\.gitCleanTitle/);
  assert.match(explorerSource, /files\.gitCleanDesc/);
  assert.match(explorerSource, /files\.gitCleanAndSynced/);

  // Push button is guarded by ahead > 0
  assert.match(explorerSource, /gitInfo\.ahead > 0/);
  assert.match(explorerSource, /files\.gitPushAhead/);

  // Release notes modal decoupling
  assert.match(explorerSource, /releaseNotesModalOpen/);
  assert.match(explorerSource, /gitAiReleaseNotesModalTitle/);

  // i18n keys are declared in both locales
  for (const key of [
    "files.gitCleanTitle",
    "files.gitCleanDesc",
    "files.gitCleanAndSynced",
    "files.gitPushAhead",
    "files.gitAiReleaseNotesModalTitle",
    "files.gitAiReleaseNotesHint",
  ]) {
    assert.match(zhSource, new RegExp(key.replace(".", "\\.")));
    assert.match(enSource, new RegExp(key.replace(".", "\\.")));
  }
});

test("Trae-style Source Control layout and color tokens", () => {
  // Color system consistency: green-600 #16a34a for added/untracked
  assert.match(explorerSource, /added:\s*"#16a34a"/);
  assert.match(explorerSource, /untracked:\s*"#16a34a"/);
  assert.match(explorerSource, /deleted:\s*"#dc2626"/);

  // Commit box with placeholder
  assert.match(explorerSource, /files\.gitCommitPlaceholder/);
  assert.match(zhSource, /files\.gitCommitPlaceholder/);
  assert.match(enSource, /files\.gitCommitPlaceholder/);

  // ChangeRow displays filename and direction-rtl path
  assert.match(explorerSource, /direction:\s*"rtl"/);
});
