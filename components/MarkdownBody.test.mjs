import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { createJiti } from "jiti";
import { installEnglishTestLocale, markupText, testTranslator } from "./test-locale.mjs";

const jiti = createJiti(import.meta.url, {
  fsCache: false,
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
await installEnglishTestLocale(jiti);
const { MarkdownBody, getMarkdownImageWidth } = await jiti.import("./MarkdownBody.tsx");
const { readImageGenerationCosts } = await jiti.import("../lib/image-generation-cost.ts");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { normalizeDisplayMath, markdownPreviewRemarkPlugins, markdownPreviewRehypePlugins } = await jiti.import("../lib/markdown.ts");
const globalsCss = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const markdownBodySource = readFileSync(new URL("./MarkdownBody.tsx", import.meta.url), "utf8");

function renderMarkdown(markdown, sessionId, remotePeer, options = {}) {
  if (sessionId && typeof sessionId === "object") {
    options = sessionId;
    sessionId = undefined;
  }
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MarkdownBody, {
        cwd: "/home/me/project",
        sessionId,
        remotePeer,
        onOpenFile() {},
        ...options,
      }, markdown),
    ),
  );
}

test("opens non-file markdown links in a safe new tab", () => {
  const html = renderMarkdown("[docs](https://example.com/docs)");

  assert.match(
    html,
    /<a (?=[^>]*href="https:\/\/example\.com\/docs")(?=[^>]*target="_blank")(?=[^>]*rel="noopener noreferrer")[^>]*>docs<\/a>/,
  );
  assert.doesNotMatch(html, /\snode=/);
});

test("keeps local file markdown links in the app", () => {
  const html = renderMarkdown("[file](components/MarkdownBody.tsx)");

  assert.match(html, /<a href="components\/MarkdownBody\.tsx">file<\/a>/);
  assert.doesNotMatch(html, /target=|rel=|\snode=/);
});

test("Windows drive links survive sanitization without allowing other schemes", () => {
  for (const options of [{}, { keepLineBreaks: true, literalHtml: true }]) {
    const html = renderMarkdown("[drive](C:/work/file.md) [reference][drive]\n\n[drive]: /D:/docs/readme.md\n\n[unsafe](javascript:alert(1))", options);
    assert.match(html, /href="file:\/\/\/C:\/work\/file\.md"/);
    assert.match(html, /href="file:\/\/\/D:\/docs\/readme\.md"/);
    assert.doesNotMatch(html, /href="javascript:/);
  }
  const preview = renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: markdownPreviewRemarkPlugins, rehypePlugins: markdownPreviewRehypePlugins, urlTransform: value => value }, "[drive](C:/work/file.md)"));
  assert.match(preview, /href="file:\/\/\/C:\/work\/file\.md"/);
});

test("keeps standalone inline code and table-cell Markdown text selectable", () => {
  const standalone = renderMarkdown("`standalone-token`");
  const table = renderMarkdown(
    "| Key | Detail |\n| --- | --- |\n| `row-id` | A deliberately wide cell that wraps within the table |",
  );

  assert.match(standalone, /<code class="markdown-inline-code"[^>]*>standalone-token<\/code>/);
  assert.match(table, /class="markdown-table-wrap markdown-table-wrap--wrap">[\s\S]*?<table>[\s\S]*?<td><code class="markdown-inline-code"[^>]*>row-id<\/code><\/td>/);
  assert.match(globalsCss, /\.chat-transcript \.markdown-body \{[\s\S]*?user-select:\s*text;/);
  const codeRule = globalsCss.match(/\.markdown-body \.markdown-inline-code \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(codeRule, "chat inline-code style missing");
  assert.doesNotMatch(codeRule, /user-select:\s*none/);
  assert.match(globalsCss, /\.markdown-table-wrap \{[\s\S]*?overflow-x:\s*auto;/);
  assert.match(globalsCss, /\.markdown-table-scroll > table\s*\{\s*width:\s*max-content;/);
});

test("routes absolute markdown images through the session-authorized file API", () => {
  const html = renderMarkdown(
    "![poster](/Users/me/Downloads/pi-generated/Pictures/poster.png)",
    "550e8400-e29b-41d4-a716-446655440000",
  );

  assert.match(
    html,
    /<img src="\/api\/files\/Users\/me\/Downloads\/pi-generated\/Pictures\/poster\.png\?type=read&amp;sessionId=550e8400-e29b-41d4-a716-446655440000"/,
  );
});

test("routes remote markdown images through the selected peer file API", () => {
  const html = renderMarkdown(
    "![poster](/Volumes/project/Pictures/poster.png)",
    "550e8400-e29b-41d4-a716-446655440000",
    "mac mini",
  );

  assert.match(
    html,
    /<img src="\/api\/remote\/files\/Volumes\/project\/Pictures\/poster\.png\?type=read&amp;sessionId=550e8400-e29b-41d4-a716-446655440000&amp;peer=mac%20mini"/,
  );
});

test("shows a verified charge below only the exact generated image, including linked images", () => {
  const output = { version: 1, toolCallId: "call-1", files: ["/tmp/a.png"], usageIds: ["image-generation:a"] };
  const billing = { status: "confirmed", currency: "USD", amount: 0.015, credits: 0.15, source: "apimart-task", taskId: "task-a", toolCallId: "call-1", startedAt: 1, resolution: "2K", returnedImages: 1 };
  const costs = [{ id: "image-generation:a", provider: "apimart", model: "gpt-image-2", status: "confirmed", amount: 0.015, billing, outputs: [output] }];
  const html = renderMarkdown("![generated](/tmp/a.png)\n\n![unrelated](/tmp/b.png)", { imageGenerationCosts: costs });
  assert.equal((html.match(/data-cost-placement="image"/g) ?? []).length, 1);
  assert.ok(html.indexOf('alt="generated"') < html.indexOf('data-cost-placement="image"'));
  assert.ok(html.indexOf('data-cost-placement="image"') < html.indexOf('alt="unrelated"'));
  assert.match(html, /Actual charge \$0\.015/);
  assert.match(html, /0\.15 credits/);
  assert.match(html, /gpt-image-2 · 2K · Verified/);
  const linked = renderMarkdown("[![generated](/tmp/a.png)](https://example.com)", { imageGenerationCosts: costs });
  assert.match(linked, /<a [^>]*><img [^>]*alt="generated"[^>]*><\/a><span data-image-generation-cost/);
  assert.doesNotMatch(linked, /<a [^>]*>[\s\S]*?<button[\s\S]*?<\/a>/);
});

test("shows a verified charge for a remote image with a provider-shaped tool ID", () => {
  const toolCallId = "call_fixture|fc_fixture";
  const file = "/Volumes/移动扩展盘/绘图专区/generated.png";
  const output = { version: 1, toolCallId, files: [file], usageIds: ["image-generation:a"] };
  const billing = { status: "confirmed", currency: "USD", amount: 0.0085, credits: 0.085, source: "apimart-task", taskId: "task-a", toolCallId, startedAt: 1, returnedImages: 1 };
  const imageGenerationCosts = readImageGenerationCosts([{ id: "image-generation:a", provider: "apimart", model: "gpt-image-2.5-ext", status: "confirmed", amount: 0.0085, billing, outputs: [output] }]);
  const html = renderMarkdown(`![generated](${file})`, "session-id", "macbook-air", { imageGenerationCosts });
  assert.ok(html.indexOf('alt="generated"') < html.indexOf('data-cost-placement="image"'));
  assert.match(html, /Actual charge \$0\.0085/);
  assert.match(html, /0\.085 credits/);
});

test("an image with an unconfirmed charge does not display a zero amount", () => {
  const output = { version: 1, toolCallId: "pending", files: ["/tmp/wait.png"], usageIds: ["image-generation:pending"] };
  const billing = { status: "pending", currency: "USD", source: "apimart-task", taskId: "task-pending", toolCallId: "pending", startedAt: 1 };
  const costs = [{ id: "image-generation:pending", provider: "apimart", model: "m", status: "pending", amount: null, billing, outputs: [output] }];
  const html = renderMarkdown("![wait](/tmp/wait.png)", { imageGenerationCosts: costs });
  assert.match(html, /data-cost-placement="image"/);
  assert.match(html, /Pending reconciliation/);
  assert.doesNotMatch(html, /\$0/);
});

test("batch charges under each result are explicitly not per-image prices", () => {
  const output = { version: 1, toolCallId: "batch", files: ["/tmp/a.png", "/tmp/b.png"], usageIds: ["image-generation:batch"] };
  const billing = { status: "confirmed", currency: "USD", amount: 0.015, source: "apimart-task", taskId: "batch-task", toolCallId: "batch", startedAt: 1, returnedImages: 2 };
  const costs = [{ id: "image-generation:batch", provider: "apimart", model: "m", status: "confirmed", amount: 0.015, billing, outputs: [output] }];
  const html = renderMarkdown("![a](/tmp/a.png)\n\n![b](/tmp/b.png)", { imageGenerationCosts: costs });
  assert.equal((html.match(/Batch charges, not per-image prices/g) ?? []).length, 2);
  assert.equal((html.match(/Actual charge \$0\.015/g) ?? []).length, 2);
});

test("renders an independent layout toggle for each Markdown table", () => {
  const html = renderMarkdown("Table one:\n\n| Name | Description |\n| --- | --- |\n| one | first |\n\nTable two:\n\n| Other | Details |\n| --- | --- |\n| two | second |");

  assert.equal((html.match(/class="markdown-table-toggle"/g) ?? []).length, 2);
  assert.equal((html.match(/class="markdown-table-wrap markdown-table-wrap--wrap"/g) ?? []).length, 2);
  assert.equal((html.match(/aria-label="Scroll horizontally"/g) ?? []).length, 2);
  assert.equal((html.match(/title="Scroll horizontally"/g) ?? []).length, 2);
  assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 2);
  assert.equal((html.match(/<svg[^>]*aria-hidden="true"/g) ?? []).length, 2);
  assert.doesNotMatch(html, />(?:Wrap text|Scroll horizontally)<\/button>/);
  assert.equal((html.match(/class="markdown-table-scroll"/g) ?? []).length, 2);
  assert.match(globalsCss, /\.markdown-table-toggle::after\s*\{[\s\S]*?content:\s*attr\(title\);/);
});

test("wraps tables by default with natural column widths and breakable long tokens", () => {
  const html = renderMarkdown("| Key | URL |\n| --- | --- |\n| `row-id` | https://example.com/" + "unbrokentoken".repeat(20) + " |");
  assert.match(html, /class="markdown-table-wrap markdown-table-wrap--wrap"/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /aria-label="Scroll horizontally"/);
  assert.match(globalsCss, /\.markdown-table-scroll\s*\{[\s\S]*?overflow-x:\s*auto;/);
  const wrapTableRule = globalsCss.match(/\.markdown-table-wrap--wrap \.markdown-table-scroll > table\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(wrapTableRule, /width:\s*100%;/);
  assert.match(wrapTableRule, /table-layout:\s*auto;/);
  assert.doesNotMatch(wrapTableRule, /table-layout:\s*fixed;/);
  const wrapCellRule = globalsCss.match(/\.markdown-table-wrap--wrap \.markdown-table-scroll th,\s*\.markdown-table-wrap--wrap \.markdown-table-scroll td\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(wrapCellRule, /overflow-wrap:\s*anywhere;/);
});

test("renders a floating preview control for markdown images", () => {
  const html = renderMarkdown("![poster](https://example.com/poster.png)");

  assert.match(html, /class="markdown-image-frame"/);
  const zoomImage = markupText(testTranslator("en")("markdown.zoomImage"));
  assert.ok(html.includes(`aria-label="${zoomImage}"`));
  assert.ok(html.includes(`title="${zoomImage}"`));
  assert.match(markdownBodySource, /startEmbeddedImagePreview\(/);
  assert.match(markdownBodySource, /previewOpen && !previewLifecycleRef\.current\?\.embedded/);
});

test("collapses failed markdown images into a compact unavailable state", () => {
  assert.match(markdownBodySource, /const \[imageError, setImageError\] = useState\(false\);/);
  assert.match(markdownBodySource, /onError=\{handleError\}/);
  assert.match(markdownBodySource, /if \(imageError\) \{[\s\S]*?className="markdown-image-unavailable"[\s\S]*?chat\.imageUnavailable/);
  const fallbackRule = globalsCss.match(/\.markdown-image-unavailable\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(fallbackRule, /display:\s*inline-flex/);
  assert.match(fallbackRule, /max-width:\s*100%/);
  assert.doesNotMatch(fallbackRule, /(?:^|\s)width:\s*100%/);
});

test("chooses full width for landscape images and half width for portrait images", () => {
  assert.equal(getMarkdownImageWidth(1600, 900), "100%");
  assert.equal(getMarkdownImageWidth(900, 1600), "50%");
  assert.equal(getMarkdownImageWidth(1000, 1000), "50%");
});

test("clips Markdown spill without creating a vertical scroll owner", () => {
  const rule = globalsCss.match(/\.markdown-body\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(rule, /overflow-x:\s*clip;/);
  assert.match(rule, /overflow-y:\s*visible;/);
  assert.doesNotMatch(rule, /overflow-x:\s*hidden;/);
});


test("keeps custom-message list markers inside bounded cards with 28px padding", () => {
  const rule = globalsCss.match(/\.markdown-custom-message ul,\s*\.markdown-custom-message ol\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(rule, /padding-left:\s*28px;/);
});

test("uses standard list markers with 28px padding to accommodate WebKit and Blink", () => {
  const listRule = globalsCss.match(/\.markdown-body ul, \.markdown-body ol\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(listRule, /padding-left:\s*28px;/);
  assert.match(listRule, /list-style-position:\s*outside;/);

  const olRule = globalsCss.match(/\.markdown-body ol > li\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(olRule, /list-style-type:\s*decimal;/);
});

test("leaves paint room for multi-digit outside list markers", () => {
  const rule = globalsCss.match(/\.markdown-body\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(rule, /overflow-clip-margin:\s*2em;/);
});

test("keeps single-tilde CJK numeric ranges literal instead of striking them", () => {
  const html = renderMarkdown("5~7U 保证金 × 100~200倍杠杆");

  assert.doesNotMatch(html, /<del>/);
  assert.match(html, /5~7U/);
  assert.match(html, /100~200倍/);
});

test("still renders double-tilde strikethrough", () => {
  const html = renderMarkdown("~~gone~~");

  assert.match(html, /<del>gone<\/del>/);
});

test("renders LaTeX parenthesis delimiters as inline math", () => {
  const html = renderMarkdown(String.raw`射线为 \(r_c = K^{-1}p\)。`);

  assert.match(html, /class="katex"/);
  assert.match(html, /r_c/);
});

test("keeps prices and bold headings intact across a paragraph line break", () => {
  const html = renderMarkdown("**3. Membership — $20/mo (+tax)**\nOne free hour monthly. Waives the $6 activation fee.\n→ https://example.com/pricing");

  assert.match(html, /<strong>3\. Membership — \$20\/mo \(\+tax\)<\/strong>/);
  assert.match(html, /One free hour monthly\. Waives the \$6 activation fee\./);
  assert.match(html, /href="https:\/\/example\.com\/pricing"/);
  assert.doesNotMatch(html, /class="katex|\*\*/);
});

test("keeps Chinese emphasis and math while preserving code, raw HTML, and link safety", () => {
  const html = renderMarkdown("**中文强调** 与 *中文说明*，价格 $20，公式 $x + 1$，代码 `$20 + $6`。<script>alert(1)</script>[危险](javascript:alert(1))");

  assert.match(html, /<strong>中文强调<\/strong>/);
  assert.match(html, /<em>中文说明<\/em>/);
  assert.match(html, /价格 \$20/);
  assert.match(html, /class=\"katex\"/);
  assert.match(html, /<code[^>]*class=\"markdown-inline-code\"[^>]*>\$20 \+ \$6<\/code>/);
  assert.doesNotMatch(html, /<script|javascript:|alert\(1\)/);
});

test("keeps adjacent amounts, ranges and decimals as currency", () => {
  for (const prices of ["$15+$15", "$20–$30", "$1,200.50 or $900.00", "**$20** and *$6*", "US$20 / CA$30"]) {
    const html = renderMarkdown(prices);
    assert.doesNotMatch(html, /class="katex/, prices);
    assert.equal((html.match(/\$/g) ?? []).length, 2, prices);
  }
});

test("does not let a price consume later math in the same paragraph", () => {
  const html = renderMarkdown("Pay $20 for the $x + 1$ option, or $30 for $2x + 3$.");

  assert.match(html, /Pay \$20 for the/);
  assert.match(html, /or \$30 for/);
  assert.equal((html.match(/class="katex"/g) ?? []).length, 2);
  assert.match(html, /<annotation encoding="application\/x-tex">x \+ 1<\/annotation>/);
  assert.match(html, /<annotation encoding="application\/x-tex">2x \+ 3<\/annotation>/);
});

test("retains single-dollar equations, numeric math, balanced padding and multiline math", () => {
  for (const math of ["$x + y$", "$2 + 2 = 4$", "$20$", "$ x + y $", "$x $", "$ x$", "$x$2", "$x +\ny$", "$$x + y$$"]) {
    const html = renderMarkdown(math);
    assert.match(html, /class="katex"/, math);
    assert.doesNotMatch(html, /katex-error/, math);
  }
});

test("file previews and minimap Markdown use the same currency-safe math rules", () => {
  const html = renderToStaticMarkup(React.createElement(ReactMarkdown, {
    remarkPlugins: markdownPreviewRemarkPlugins,
    rehypePlugins: markdownPreviewRehypePlugins,
  }, "**Price: $20/month**\nPlus a $6 fee. Formula: $2 + 2 = 4$."));
  assert.match(html, /<strong>Price: \$20\/month<\/strong>/);
  assert.match(html, /Plus a \$6 fee/);
  assert.equal((html.match(/class="katex"/g) ?? []).length, 1);
});

test("leaves escaped currency, code and link destinations intact", () => {
  const html = renderMarkdown("Prices: \\$20 and \\$6. Code: `$20 + $6`. [Price](https://example.com/$20/$6)");
  assert.doesNotMatch(html, /class="katex/);
  assert.match(html, /Prices: \$20 and \$6\./);
  assert.match(html, /<code[^>]*>\$20 \+ \$6<\/code>/);
  assert.match(html, /href="https:\/\/example\.com\/\$20\/\$6"/);
  const fenced = renderMarkdown("```text\n$20 + $6\n```");
  assert.doesNotMatch(fenced, /class="katex/);
});

test("currency text still passes through HTML and URL sanitization", () => {
  const html = renderMarkdown('$20 <img src="x" onerror="alert(1)"> $6 [click](javascript:alert(1))');
  assert.doesNotMatch(html, /onerror|javascript:|class="katex/);
  assert.match(html, /\$20/);
  assert.match(html, /\$6/);
});

test("renders paired LaTeX bracket delimiters as display math", () => {
  const html = renderMarkdown(String.raw`\[
P(\lambda)=o_b+\lambda r_b
\]`);
  const oneLineHtml = renderMarkdown(String.raw`\[P(\lambda)=o_b+\lambda r_b\]`);

  assert.match(html, /class="katex-display"/);
  assert.match(html, /lambda/);
  assert.match(oneLineHtml, /class="katex-display"/);
});

test("leaves an unmatched LaTeX bracket delimiter unchanged", () => {
  const markdown = String.raw`before
\[
x + y
after`;

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize LaTeX delimiters inside Markdown code", () => {
  const markdown = "    \\(indented\\)\n\n`code\n\\(inline\\)`\n\n```text\n\\[\nfenced\n\\]\n```";

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize LaTeX delimiters inside raw HTML code", () => {
  const markdown = "<code>\\(inline\\)</code>\n\n<pre>\n\\(block\\)\n</pre>";

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize escaped delimiters or link destinations", () => {
  const escaped = String.raw`Literal: \\(x+y\\).`;
  const link = String.raw`[docs](https://example.com/\(manual\))`;

  assert.equal(normalizeDisplayMath(escaped), escaped);
  assert.equal(normalizeDisplayMath(link), link);
});

test("renders repeated markdown image sources only once", () => {
  const html = renderMarkdown(
    "![first](https://example.com/poster.png)\n\n说明\n\n![duplicate](https://example.com/poster.png)",
    undefined,
    undefined,
    { dedupeImages: true },
  );

  assert.equal((html.match(/<img /g) ?? []).length, 1);
});

test("keeps Markdown renderer identities stable across parent re-renders", () => {
  assert.match(markdownBodySource, /const components = useMemo<Components>\(\(\) => \(\{/);
  assert.match(markdownBodySource, /const components[\s\S]*?\}\), \[cwd, dedupeImages, imageGenerationCosts, isStreaming, onNavigateLink, onOpenFile, remotePeer, sessionId\]\);/);
});

test("previews completed Mermaid code while keeping streaming code visible", () => {
  const completed = renderMarkdown("```mermaid\ngraph TD\n  A --> B\n```", undefined, undefined, { isStreaming: false });
  assert.match(completed, /mermaid-block-loading/);
  assert.doesNotMatch(completed, /A --&gt; B/);

  const streaming = renderMarkdown("```mermaid\ngraph TD\n  A --> B\n```", undefined, undefined, { isStreaming: true });
  assert.doesNotMatch(streaming, /mermaid-block-loading/);
  assert.match(streaming, /A --&gt; B/);
});


test("keeps currency math, CJK autolinks and preview Markdown on shared plugins", () => {
  const html = renderMarkdown("Pay $20 for the $x + 1$ option，见 https://example.com/docs。", undefined, undefined);
  assert.match(html, /Pay \$20 for the/);
  assert.equal((html.match(/class="katex"/g) ?? []).length, 1);
  assert.match(html, /href="https:\/\/example\.com\/docs"/);
  assert.match(html, /<\/a>。/);

  const preview = renderToStaticMarkup(React.createElement(ReactMarkdown, {
    remarkPlugins: markdownPreviewRemarkPlugins,
    rehypePlugins: markdownPreviewRehypePlugins,
  }, "**Price: $20\/month**\nPlus a $6 fee. Formula: $2 + 2 = 4$."));
  assert.match(preview, /<strong>Price: \$20\/month<\/strong>/);
  assert.equal((preview.match(/class="katex"/g) ?? []).length, 1);
});

test("keeps linked images as routed bare images without nested preview controls", () => {
  const html = renderMarkdown("[![diagram](/home/me/project/docs/diagram.png)](https://example.com/docs)", "session-1", "mac mini");

  assert.match(html, /<a (?=[^>]*href="https:\/\/example\.com\/docs")[^>]*>/);
  assert.match(html, /<img[^>]+src="\/api\/remote\/files\/home\/me\/project\/docs\/diagram\.png\?type=read&amp;sessionId=session-1&amp;peer=mac%20mini"/);
  assert.doesNotMatch(html, /<a[^>]*>[\s\S]*<button/);
  assert.doesNotMatch(html, /<button[^>]*>[\s\S]*<\/a>/);
});

test("keeps user line endings only when keepLineBreaks is requested", () => {
  assert.doesNotMatch(renderMarkdown("one\ntwo"), /<br/);
  for (const markdown of ["one\ntwo", "one\r\ntwo", "one\rtwo", "one  \t\n  two"]) {
    assert.match(renderMarkdown(markdown, undefined, undefined, { keepLineBreaks: true }), /<p>one<br\/>two<\/p>/);
  }

  const ordered = renderMarkdown("1. 看门狗的原理是（ ）\nA. 监控温度\nB. 计数器\n2. 下一题", undefined, undefined, { keepLineBreaks: true });
  assert.match(ordered, /<li>看门狗的原理是（ ）<br\/>A\. 监控温度<br\/>B\. 计数器<\/li>/);
  assert.doesNotMatch(renderMarkdown("- alpha\n\n- beta", undefined, undefined, { keepLineBreaks: true }), /<br/);
});

test("does not add line breaks inside code, math or raw-text HTML", () => {
  const code = renderMarkdown("```\nfirst\nsecond\n```", undefined, undefined, { keepLineBreaks: true });
  const math = renderMarkdown("$$\nx = 1\ny = 2\n$$", undefined, undefined, { keepLineBreaks: true });
  assert.doesNotMatch(code, /<br/);
  assert.doesNotMatch(math, /<br/);

  for (const markdown of [
    "Use a <textarea> here\nand a button\nplease",
    "add <script>a()\nb()</script> to the page\nthen reload",
  ]) {
    assert.equal(
      renderMarkdown(markdown, undefined, undefined, { keepLineBreaks: true }),
      renderMarkdown(markdown),
    );
  }
});

test("keeps CJK prose out of an autolinked URL", () => {
  const html = renderMarkdown("开 http://localhost:4321，或直接开 library/x.png。");

  assert.match(html, /<a (?=[^>]*href="http:\/\/localhost:4321")[^>]*>http:\/\/localhost:4321<\/a>/);
  assert.match(html, /<\/a>，或直接开 library\/x\.png。/);
  assert.doesNotMatch(html, /%EF%BC%8C/);
});

test("stops a bare autolink at trailing CJK punctuation", () => {
  const html = renderMarkdown("见 https://example.com/docs。");

  assert.match(html, /<a (?=[^>]*href="https:\/\/example\.com\/docs")[^>]*>https:\/\/example\.com\/docs<\/a>/);
  assert.match(html, /<\/a>。/);
});

test("leaves explicit markdown links, CJK paths and query strings intact", () => {
  const explicit = renderMarkdown("[文档](https://example.com/docs)，说明");
  assert.match(explicit, /<a (?=[^>]*href="https:\/\/example\.com\/docs")[^>]*>文档<\/a>/);
  assert.match(explicit, /<\/a>，说明/);

  const cjkPath = renderMarkdown("https://zh.wikipedia.org/wiki/中文条目");
  assert.match(cjkPath, /href="https:\/\/zh\.wikipedia\.org\/wiki\/%E4%B8%AD%E6%96%87%E6%9D%A1%E7%9B%AE"/);

  const query = renderMarkdown("https://a.com/p?a=1&b=2，后面");
  assert.match(query, /href="https:\/\/a\.com\/p\?a=1&amp;b=2"/);
  assert.match(query, /<\/a>，后面/);
});

test("turns line endings into <br> only when asked to keep line breaks", () => {
  assert.match(renderMarkdown("one\ntwo"), /<p>one\ntwo<\/p>/);
  assert.doesNotMatch(renderMarkdown("one\ntwo"), /<br/);

  for (const markdown of ["one\ntwo", "one\r\ntwo", "one\rtwo", "one   \t\n   two"]) {
    assert.match(renderMarkdown(markdown, { keepLineBreaks: true }), /<p>one<br\/>two<\/p>/);
  }
});

test("keeps typed line breaks in tight list items and headings", () => {
  const ordered = renderMarkdown("1. 看门狗的原理是（ ）\nA. 监控温度\nB. 计数器\n2. 下一题", { keepLineBreaks: true });
  const nested = renderMarkdown("- outer\n  more\n  - inner\n- next", { keepLineBreaks: true });
  const heading = renderMarkdown("Heading one\nheading two\n===", { keepLineBreaks: true });

  assert.match(ordered, /<li>看门狗的原理是（ ）<br\/>A\. 监控温度<br\/>B\. 计数器<\/li>/);
  assert.match(ordered, /<li>下一题<\/li>/);
  // The newline before a nested list separates blocks, so it must not become a <br>.
  assert.match(nested, /<li>outer<br\/>more\n<ul>\n<li>inner<\/li>/);
  assert.match(heading, /<h1[^>]*>Heading one<br\/>heading two<\/h1>/);
  assert.doesNotMatch(renderMarkdown("- alpha\n\n- beta", { keepLineBreaks: true }), /<br/);
});

test("renders a hard break once when keeping line breaks", () => {
  // remark-rehype writes an mdast break as <br> plus "\n", which the user
  // bubble's pre-wrap paragraphs would show as a blank line.
  const html = renderMarkdown("trailing spaces  \nbackslash\\\nend", { keepLineBreaks: true });

  assert.match(html, /<p>trailing spaces<br\/>backslash<br\/>end<\/p>/);
});

test("leaves code and math line endings alone when keeping line breaks", () => {
  const code = renderMarkdown("```\nfirst\nsecond\n```", { keepLineBreaks: true });
  const math = renderMarkdown("$$\nx = 1\ny = 2\n$$", { keepLineBreaks: true });
  const emphasis = renderMarkdown("*one\ntwo* `a b`", { keepLineBreaks: true });

  assert.doesNotMatch(code, /<br/);
  assert.match(code, /first[\s\S]*\n[\s\S]*second/);
  assert.doesNotMatch(math, /<br/);
  assert.match(math, /<annotation encoding="application\/x-tex">x = 1\ny = 2<\/annotation>/);
  assert.match(emphasis, /<em>one<br\/>two<\/em>/);
});

test("chat and preview headings receive document-scoped anchors without global IDs", () => {
  const source = "Setext\n======\n\n## Second `code`\n\n## Second `code`\n\n[jump](#second-code-1)";
  const chat = renderMarkdown(source);
  assert.match(chat, /<h1 data-heading-anchor="setext"/);
  assert.match(chat, /<h2 data-heading-anchor="second-code"/);
  assert.match(chat, /<h2 data-heading-anchor="second-code-1"/);
  assert.match(chat, /data-heading-anchor="setext" data-heading-source-line="1"/);
  assert.match(chat, /data-heading-anchor="second-code" data-heading-source-line="4"/);
  assert.doesNotMatch(chat, /<h[12] id=/);
  const preview = renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: markdownPreviewRemarkPlugins, rehypePlugins: markdownPreviewRehypePlugins }, source));
  assert.match(preview, /<h1 data-heading-anchor="setext"/);
  assert.match(preview, /<h2 data-heading-anchor="second-code"/);
});

test("block math offers a copy control without trusting user HTML attributes", () => {
  const block = renderMarkdown("$$\nx^2 + y^2\n$$");
  assert.match(block, /class="markdown-math-display"/);
  assert.match(block, /class="markdown-code-action markdown-math-copy">Copy/);
  assert.match(block, /<annotation encoding="application\/x-tex">x\^2 \+ y\^2<\/annotation>/);
  assert.doesNotMatch(renderMarkdown("Inline $x^2$"), /markdown-math-copy/);
  assert.doesNotMatch(renderMarkdown('<div data-math-source="forged">hello</div>'), /markdown-math-copy/);
});

test("user HTML remains visible text while markdown and code stay intact", () => {
  const options = { keepLineBreaks: true, literalHtml: true };
  const inline = renderMarkdown('Text <b>bold</b> <img src=x onerror="alert(1)">\nnext', options);
  assert.match(inline, /&lt;b&gt;bold&lt;\/b&gt;/);
  assert.match(inline, /&lt;img src=x onerror=/);
  assert.match(inline, /<br\/>next/);
  assert.doesNotMatch(inline, /<b>|<img /i);
  const hidden = renderMarkdown('<div style="display:none">visible text</div>\n\n<script>run()\nmore()</script>', options);
  assert.match(hidden, /&lt;div style=/);
  assert.match(hidden, /visible text/);
  assert.match(hidden, /&lt;script&gt;run\(\)\s*<br\/>\s*more\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(hidden, /<script|<div style=/);
  const unclosed = renderMarkdown('before <textarea>\nafter', options);
  assert.match(unclosed, /&lt;textarea&gt;<br\/>after/);
  const code = renderMarkdown('```html\n<b>literal</b>\n```\n\n**bold**', options);
  assert.match(code.replace(/<[^>]*>/g, ""), /&lt;b&gt;literal&lt;\/b&gt;/);
  assert.match(code, /<strong>bold<\/strong>/);
  assert.match(renderMarkdown('<b>assistant</b>'), /<b>assistant<\/b>/);
});

test("keeps a block that opens a raw-text tag as it renders without line breaks", () => {
  // A <br> after an unclosed <textarea> or <script> ends rehype-raw's raw-text
  // state, which glued the lines together or dropped the rest of the block.
  for (const markdown of [
    "Use a <textarea> here\nand a button\nplease",
    "Set <title>My\nPage</title> first\nthen deploy",
    "add <script>a()\nb()</script> to the page\nthen reload",
    "some *<style>x\ny</style>* then\nnext",
  ]) {
    assert.equal(renderMarkdown(markdown, { keepLineBreaks: true }), renderMarkdown(markdown));
  }

  assert.match(renderMarkdown("normal <kbd>Ctrl</kbd>\nline two", { keepLineBreaks: true }), /<\/kbd><br\/>line two/);
  const list = renderMarkdown("- item <textarea>\n  more\n- two\n  lines", { keepLineBreaks: true });
  assert.match(list, /<li>two<br\/>lines<\/li>/);
});

test("a local audio path in image syntax becomes an inline player, not a broken image", () => {
  const html = renderMarkdown(
    "![voice note](/Users/me/project/clips/voice.wav)",
    "550e8400-e29b-41d4-a716-446655440000",
  );

  assert.match(
    html,
    /<audio controls="" preload="metadata" src="\/api\/files\/Users\/me\/project\/clips\/voice\.wav\?type=read&amp;sessionId=550e8400-e29b-41d4-a716-446655440000" title="voice note"/,
  );
  assert.doesNotMatch(html, /<img /);
});

test("a remote local video path keeps peer routing", () => {
  const html = renderMarkdown(
    "![clip](/Volumes/project/clips/demo.mp4)",
    "550e8400-e29b-41d4-a716-446655440000",
    "mac mini",
  );

  assert.match(
    html,
    /<video controls="" preload="metadata" src="\/api\/remote\/files\/Volumes\/project\/clips\/demo\.mp4\?type=read&amp;sessionId=550e8400-e29b-41d4-a716-446655440000&amp;peer=mac%20mini"/,
  );
});

test("an external media URL is left to the browser's own image handling", () => {
  // Only local paths resolve through the file API; a remote https media URL
  // must not be turned into a player that bypasses the markdown URL policy.
  const html = renderMarkdown("![clip](https://example.test/clip.mp4)");

  assert.match(html, /<img /);
  assert.doesNotMatch(html, /<video /);
});

test("media inside a link keeps the link as the only interactive owner", () => {
  const html = renderMarkdown("[![voice](/Users/me/project/voice.wav)](/Users/me/project/notes.md)");

  assert.doesNotMatch(html, /<audio /);
  // The outer anchor is the only interactive control; the media becomes text.
  assert.equal((html.match(/<a /g) ?? []).length, 1);
  assert.match(html, /voice/);
});

test("an svg fence previews only through an isolated img data URL", () => {
  const html = renderMarkdown("```svg\n<svg xmlns=\"http://www.w3.org/2000/svg\"><circle r=\"4\"/></svg>\n```");

  assert.match(html, /class="svg-block-preview"/);
  assert.match(html, /<img src="data:image\/svg\+xml;charset=utf-8,%3Csvg/);
  // The markup must never reach the page DOM, where it could run script.
  assert.doesNotMatch(html, /<circle/);
  assert.match(html, /download="image\.svg"/);
});

test("an incomplete or streaming svg fence stays source", () => {
  const incomplete = renderMarkdown("```svg\n<svg xmlns=\"http://www.w3.org/2000/svg\"><circle r=\"4\"/>");
  assert.doesNotMatch(incomplete, /svg-block-preview/);

  const streaming = renderMarkdown(
    "```svg\n<svg xmlns=\"http://www.w3.org/2000/svg\"><circle r=\"4\"/></svg>\n```",
    { isStreaming: true },
  );
  assert.doesNotMatch(streaming, /svg-block-preview/);
});

test("svg with a script or event handler is still confined to the img", () => {
  const html = renderMarkdown(
    "```svg\n<svg xmlns=\"http://www.w3.org/2000/svg\" onload=\"alert(1)\"><script>alert(1)</script></svg>\n```",
  );

  assert.match(html, /<img src="data:image\/svg\+xml/);
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /onload="alert/);
});
