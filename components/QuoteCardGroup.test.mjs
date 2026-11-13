import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });

test("QuoteCardGroup implements numbered badges [1], [2] and click-to-edit interface", async () => {
  const source = await readFile(new URL("./QuoteCardGroup.tsx", import.meta.url), "utf8");

  // Asserts numbered badges [1], [2]
  assert.match(source, /\[\{num\}\]/, "must render numbered badges [1], [2]");

  // Compact chips retain only their number
  assert.doesNotMatch(source, /const (firstLine|preview)\b|\{preview\b/, "must not render quote text in the chip");
  assert.match(source, /aria-label=\{t\("quote\.badgeLabel", \{ num \}\)\}/, "must identify number-only chips accessibly");
  const chip = source.slice(source.indexOf('{/* 单个横向排列的卡片 */}'), source.indexOf('{/* 编号的引用详情 */}'));
  assert.doesNotMatch(chip, /<button|<X\b|onRemoveQuote/, "chips must not contain a duplicate deletion control");
  assert.match(source, /className="quote-preview-source"/, "must separate selected text into a neutral inset");
  assert.match(source, /className="quote-preview-comment"/, "must group the comment separately");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.quote-preview-source\s*\{[^}]*background: var\(--bg-panel\);[^}]*color: var\(--text-muted\)/s);
  assert.match(css, /\.quote-preview-comment\s*\{[^}]*border-top: 1px solid var\(--border\)/s);
  assert.match(css, /\.quote-preview-comment\s*\{[^}]*color: var\(--text\);[^}]*font-size: 13px/s);
  for (const name of ["label", "text"]) {
    const rule = css.match(new RegExp(`\\.quote-preview-comment-${name}\\s*\\{([^}]*)\\}`));
    assert.ok(rule);
    assert.doesNotMatch(rule[1], /color:|font-size:|font-weight:|display:\s*block/, "reply label and text inherit the same typography and stay inline");
  }

  assert.match(css, /\.quote-preview-actions\s*\{[^}]*justify-content: flex-start;[^}]*padding: 4px 8px;[^}]*flex-shrink: 0/s, "actions stay in a compact left-aligned header row");
  assert.match(css, /\.quote-preview-content\s*\{[^}]*min-height: 0;[^}]*overflow-y: auto/s, "only preview content scrolls");
  assert.match(css, /\.quote-number-button:focus-visible\s*\{[^}]*outline: 2px solid var\(--accent\)/s);
  assert.match(source, /getQuotePreviewMaxHeight/);
  assert.match(source, /--quote-preview-max-height/);
  assert.match(source, /maxHeight: "var\(--quote-preview-max-height, calc\(100dvh - 24px\)\)"/);
  assert.match(source, /bottom: "calc\(100% \+ 6px\)"/);
  assert.match(source, /className="quote-preview-actions" style=\{\{ width: "max-content", gap: 2 \}\}/);
  assert.match(source, /className="quote-delete-button"[\s\S]*?boxSizing: "border-box"[\s\S]*?width: 28/);

  // Asserts click-to-edit support
  assert.match(source, /startEdit/, "must support opening edit mode on click");
  assert.match(source, /saveEdit/, "must support saving edited quote");
  assert.match(source, /cancelEdit/, "must support canceling edit");
  assert.match(source, /onUpdateQuote/, "must trigger update callback");

  // Preview header owns the remove action
  assert.match(source, /onRemoveQuote/, "must trigger remove callback");
  assert.match(source, /aria-label=\{.*quote\.remove/, "must have accessible remove button label");
});

test("GeneralConfig implements sidebar TOC and Cmd+E shortcut setting while rejecting Cmd+Shift+R", async () => {
  const source = await readFile(new URL("./GeneralConfig.tsx", import.meta.url), "utf8");

  // TOC navigation
  assert.match(source, /TOC_ITEMS/, "must define TOC navigation items");
  assert.match(source, /settings\.tocAppearance/, "must include appearance in TOC");
  assert.match(source, /settings\.tocChat/, "must include chat in TOC");
  assert.match(source, /settings\.tocSound/, "must include sound in TOC");
  assert.match(source, /scrollToSection/, "must support scrolling to section");

  // Shortcut setting
  assert.match(source, /settings\.quoteShortcut/, "must render quote shortcut setting");
  assert.match(source, /Mod\+e/, "must default to Mod+e (Cmd+E / Ctrl+E)");
  assert.match(source, /QUOTE_SHORTCUT_CHANGED_EVENT/, "must dispatch event when shortcut changes");
  assert.match(source, /shift\+r/, "must reject Shift+R to avoid colliding with hard reload");
});

test("ChatInput mounts QuoteCardGroup and guards commands from quote prefixing", async () => {
  const source = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");

  assert.match(source, /<QuoteCardGroup/, "must mount QuoteCardGroup in composer");
  assert.match(source, /addQuote\?:/, "ChatInputHandle must expose addQuote");
  assert.match(source, /formatQuoteItemsToMarkdown/, "must format quotes to markdown on submit");

  // Command guard check
  assert.match(
    source,
    /export function withQuoteContext\(message: string, quoteMarkdown: string\): string \{/,
    "must route quote injection through withQuoteContext so commands stay protected",
  );
  assert.match(source, /withQuoteContext\(msg, quoteMarkdown\)/, "must attach quotes on send and on streaming queue");
});

test("withQuoteContext sends quotes as a skill argument and skips other commands", async () => {
  const { withQuoteContext } = await jiti.import("./ChatInput.tsx");
  const quotes = "> quoted passage";

  assert.equal(withQuoteContext("/skill:plan-execute 请继续", quotes), `/skill:plan-execute 请继续\n\n${quotes}`);
  assert.equal(
    withQuoteContext("/skill:plan-execute", quotes),
    `/skill:plan-execute ${quotes}`,
    "a bare skill command needs one space so pi reads the name, not the quotes",
  );
  assert.equal(withQuoteContext("", quotes), quotes);
  assert.equal(withQuoteContext("question", quotes), `${quotes}\n\nquestion`);
  assert.equal(withQuoteContext("/compact", quotes), "/compact");
  assert.equal(withQuoteContext("!ls", quotes), "!ls");
  assert.equal(withQuoteContext("/skill:plan-execute", ""), "/skill:plan-execute");
});

test("ChatWindow binds quote shortcut and dispatches to addQuote", async () => {
  const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

  assert.match(source, /isQuoteShortcut/, "must check for quote shortcut");
  assert.match(source, /addQuote/, "must invoke addQuote on chat input handle");
  assert.match(source, /QUOTE_SHORTCUT_CHANGED_EVENT/, "must listen for shortcut change event");
});

test("SidekickDrawer uses direct textarea quote to distinguish from main chat quote cards", async () => {
  const source = await readFile(new URL("./SidekickDrawer.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /<QuoteCardGroup/, "must not mount QuoteCardGroup in Sidekick composer");
  assert.match(source, /pi-sidekick-quote/, "must listen to pi-sidekick-quote event");
  assert.match(source, /setQuestion\(\(prev\) => \(prev \? `\$\{prev\}\\n\\n\$\{quoteText\}` : quoteText\)\)/, "must directly append quote text to textarea");
});
