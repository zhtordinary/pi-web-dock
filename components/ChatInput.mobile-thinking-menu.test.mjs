import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");

test("anchors the mobile reasoning menu to its left edge", () => {
  assert.match(
    source,
    /thinkingDropdownOpen[\s\S]*?bottom: "calc\(100% \+ 6px\)"[\s\S]*?isMobile \? \{ left: 0 \} : \{ right: 0 \}/,
  );
});

test("moves streaming actions below the mobile composer text instead of squeezing it", () => {
  assert.match(source, /flexWrap: isMobile && isStreaming && \(onSteer \|\| onFollowUp\) \? "wrap" : "nowrap"/);
  const actions = source.slice(source.indexOf('data-testid="chat-input-stream-actions"'));
  assert.match(actions, /flexBasis: isMobile && \(onSteer \|\| onFollowUp\) \? "100%" : undefined/);
  assert.match(actions, /width: isMobile && \(onSteer \|\| onFollowUp\) \? "100%" : undefined/);
  assert.match(actions, /justifyContent: isMobile && \(onSteer \|\| onFollowUp\) \? "flex-end" : undefined/);
});
