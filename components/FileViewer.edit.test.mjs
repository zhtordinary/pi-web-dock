import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");

test("file editing uses one native textarea surface", () => {
  assert.match(source, /TEXT_EDIT_MAX_BYTES/);
  assert.match(source, /ref=\{editTextareaRef\}/);
  assert.match(source, /value=\{editText\}/);
  assert.match(source, /onChange=\{/);
  assert.match(source, /className="file-editor-input"/);
  assert.doesNotMatch(source, /contentEditable=/);
  assert.doesNotMatch(source, /highlightedEdit/);
  assert.doesNotMatch(source, /readTextSelection|setTextSelection/);
  assert.match(source, /editDraftRef\.current = nextDirty/);
  assert.match(source, /initialEditDraftRef/);
  assert.match(source, /nextState\.editDraft = editDraftRef\.current/);
  assert.match(source, /setDirty\(draft\.content !== loaded\.content\)/);
  assert.match(source, /method: "PUT"/);
  assert.match(source, /onDirtyChange\?: \(dirty: boolean\) => void/);
});

test("a restored draft remains visible but cannot overwrite a non-editable file", () => {
  assert.match(source, /setEditText\(draft\.content\)/);
  assert.match(source, /displayedEditError = data && !data\.editable \? t\("files\.editUnavailable"\) : editError/);
  assert.match(source, /if \(!data\.editable\) \{\s*setEditError\(t\("files\.editUnavailable"\)\);\s*return;/);
  assert.match(source, /disabled=\{!dirty \|\| isSaving \|\| !data\?\.editable\}/);
});

test("editing pauses live replacement and protects page close", () => {
  assert.match(source, /if \(!watchEnabled \|\| isEditing\) return;/);
  assert.match(source, /window\.addEventListener\("beforeunload"/);
  assert.match(source, /isEditing \? \(/);
  assert.match(source, /setData\(\(current\) => current[\s\S]*content: nextContent/);
});
