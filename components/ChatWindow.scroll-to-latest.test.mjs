import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const hookSource = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

function elementBlock() {
  const start = source.indexOf("className={`chat-scroll-to-bottom");
  assert.notEqual(start, -1, "scroll-to-latest button not found");
  const buttonStart = source.lastIndexOf("<button", start);
  const buttonEnd = source.indexOf("</button>", start);
  assert.notEqual(buttonStart, -1);
  assert.notEqual(buttonEnd, -1);
  return source.slice(buttonStart, buttonEnd);
}

test("offers latest for detached or historical readers, including a detached physical bottom", () => {
  const match = elementBlock().match(/className=\{(`chat-scroll-to-bottom[^`]*`)\}/);
  assert.ok(match, "visibility must remain a class toggle so the exit transition can play");
  for (const [showScrollToBottom, atLiveTail, follow, expected] of [
    [false, true, true, false], [false, true, false, true],
    [false, false, true, true], [true, true, true, true],
  ]) {
    const classes = vm.runInNewContext(match[1], { showScrollToBottom, atLiveTail, follow });
    assert.equal(classes.split(" ").includes("is-visible"), expected);
  }
});

test("floats the scroll-to-latest button above the composer, clear of the minimap", () => {
  const gate = source.indexOf("{!isEmptyNew && (");
  const marker = source.indexOf('className={`chat-scroll-to-bottom', gate);
  assert.notEqual(gate, -1);
  assert.notEqual(marker, -1);
  const container = source.slice(gate, marker);
  const block = elementBlock();

  assert.match(container, /position: "absolute"/);
  assert.match(container, /bottom: "100%"/);
  assert.match(container, /right: isMobile \? 0 : CHAT_MINIMAP_WIDTH/);
  assert.match(container, /justifyContent: "center"/);
  assert.match(container, /pointerEvents: "none"/);
  assert.match(cssSource, /\.chat-scroll-to-bottom\.is-visible \{[\s\S]*?pointer-events: auto;/);
  assert.match(cssSource, /\.chat-scroll-to-bottom:focus-visible \{[\s\S]*?outline: 2px solid var\(--accent\)/);
  assert.match(block, /onClick=\{\(\) => \{\s*void revealLatestHistory\(\);\s*\}\}/);
});

test("keeps the visible button faint until hover or focus", () => {
  const hidden = cssSource.slice(cssSource.indexOf(".chat-scroll-to-bottom {"));
  const visible = hidden.slice(hidden.indexOf(".chat-scroll-to-bottom.is-visible {"));
  const reveal = hidden.slice(hidden.indexOf(".chat-scroll-to-bottom.is-visible:hover"));

  assert.match(visible.slice(0, visible.indexOf("}")), /opacity: 0\.28;[\s\S]*?visibility: visible;[\s\S]*?transform: none;/);
  assert.match(reveal.slice(0, reveal.indexOf("}")), /opacity: 1;/);
  assert.match(
    cssSource,
    /\.chat-scroll-to-bottom\.is-visible:hover,\s*\.chat-scroll-to-bottom\.is-visible:focus-visible \{[\s\S]*?opacity: 1;/,
  );
});

test("fades the button in and out without motion when motion is reduced", () => {
  const hidden = cssSource.slice(cssSource.indexOf(".chat-scroll-to-bottom {"));

  assert.match(hidden.slice(0, hidden.indexOf("}")), /opacity: 0;[\s\S]*?visibility: hidden;[\s\S]*?transform: translateY\(4px\) scale\(0\.96\);/);
  assert.match(hidden.slice(0, hidden.indexOf("}")), /transition:[\s\S]*?opacity 0\.16s ease,[\s\S]*?transform 0\.16s ease,[\s\S]*?visibility 0s linear 0\.16s;/);
  assert.match(
    cssSource,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.chat-scroll-to-bottom,\s*\.chat-scroll-to-bottom\.is-visible \{\s*transform: none;\s*transition:\s*opacity 0\.16s ease,/,
  );
});

test("jumps to the live tail with the shared smooth scroll helper", () => {
  const block = elementBlock();

  assert.match(block, /aria-label=\{`\$\{t\("chat.scrollToLatest"\)/);
  assert.match(source, /scrollToBottom, scrollToMessage,/);
});

test("exposes the detached-tail flag from the session hook without a ref read", () => {
  assert.match(hookSource, /const \[showScrollToBottom, setShowScrollToBottom\] = useState\(false\)/);

  const returnStart = hookSource.lastIndexOf("\n  return {");
  assert.ok(returnStart >= 0);
  const exposed = hookSource.slice(returnStart);
  assert.match(exposed, /\bshowScrollToBottom,/);
  assert.doesNotMatch(exposed, /showScrollToBottom:\s*[^,]*\.current/);
});
