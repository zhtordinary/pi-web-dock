import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(userInfo().homedir,
  process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
const { chromium } = await import("playwright");
const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageDir = (name) => dirname(require.resolve(name));
const sources = Object.fromEntries(await Promise.all([
  ["react", join(packageDir("react"), "cjs/react.production.js")],
  ["react/jsx-runtime", join(packageDir("react"), "cjs/react-jsx-runtime.production.js")],
  ["scheduler", join(packageDir("scheduler"), "cjs/scheduler.production.js")],
  ["react-dom", join(packageDir("react-dom"), "cjs/react-dom.production.js")],
  ["react-dom/client", join(packageDir("react-dom"), "cjs/react-dom-client.production.js")],
].map(async ([name, path]) => [name, await readFile(path, "utf8")])));
const chatWindow = await readFile(join(root, "components/ChatWindow.tsx"), "utf8");
const start = chatWindow.indexOf("const QUOTE_BLOCK_TAGS");
const end = chatWindow.indexOf("function HistorySearchContent(", start);
assert.ok(start >= 0 && end > start, "the live quote decoration must be available to the fixture");
const highlightSource = stripTypeScriptTypes(chatWindow.slice(start, end));
const layerSource = await readFile(join(root, "components/TranscriptHighlights.tsx"), "utf8");
const layerModule = ts.transpileModule(layerSource, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020,
} }).outputText;

test("quote decoration preserves React-owned text through a later insertion", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(async () => browser.close());
  const page = await browser.newPage();
  await page.setContent("<!doctype html><html><body></body></html>");
  await page.evaluate(({ sources, highlightSource, layerModule }) => {
    const modules = {};
    for (const name of ["react", "react/jsx-runtime", "scheduler", "react-dom", "react-dom/client"]) {
      const loaded = { exports: {} };
      new Function("module", "exports", "require", sources[name])(loaded, loaded.exports, (id) => {
        if (!(id in modules)) throw new Error(`Unexpected fixture module: ${id}`);
        return modules[id];
      });
      modules[name] = loaded.exports;
    }
    const layer = { exports: {} };
    new Function("module", "exports", "require", layerModule)(layer, layer.exports, (id) => {
      if (!(id in modules)) throw new Error(`Unexpected layer module: ${id}`);
      return modules[id];
    });
    window.fixtureModules = modules;
    window.fixtureLayer = layer.exports.TranscriptHighlights;
    window.eval(`${highlightSource}\nwindow.fixtureFindQuoteHighlights = findQuoteHighlights;`);
  }, { sources, highlightSource, layerModule });

  const run = (mode) => page.evaluate((mode) => {
    const React = window.fixtureModules.react;
    const { flushSync } = window.fixtureModules["react-dom"];
    const { createRoot } = window.fixtureModules["react-dom/client"];
    const quoteText = Array.from({ length: 41 }, (_, i) => `${String(i).padStart(2, "0")} ${"x".repeat(i < 20 ? 17 : 16)}`).join("\n");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const errors = [];
    let update;
    function Fixture() {
      const [inserted, setInserted] = React.useState(false);
      update = setInserted;
      return React.createElement("section", { "data-chat-message-row": "true", "data-entry-id": "fixture" },
        React.createElement("p", null,
          mode === "empty" ? "first" : React.createElement("strong", null, "prefix"),
          inserted ? React.createElement("b", { "data-inserted": "true" }, "new") : null,
          mode === "empty" ? "second" : quoteText));
    }
    const reactRoot = createRoot(container, { onUncaughtError: (error) => errors.push({ name: error.name, message: error.message }) });
    flushSync(() => reactRoot.render(React.createElement(Fixture)));
    const paragraph = container.querySelector("p");
    const originalLastNode = paragraph.lastChild;
    const before = { children: paragraph.childNodes.length, quoteChars: quoteText.length };
    const highlights = mode === "control" ? [] : window.fixtureFindQuoteHighlights(container,
      mode === "quote" ? [{ id: "quote", text: quoteText, sourceEntryId: "fixture" }] : []);
    before.marks = highlights.length;
    before.originalLastNodeConnected = originalLastNode.isConnected;
    try { flushSync(() => update(true)); } catch (error) { errors.push({ name: error.name, message: error.message }); }
    const result = { before, errors, inserted: !!container.querySelector("[data-inserted]"),
      stillVisible: container.textContent.includes(mode === "empty" ? "first" : "prefix") };
    try { reactRoot.unmount(); } catch {}
    container.remove();
    return result;
  }, mode);

  await t.test("an undecorated message accepts a later sibling", async () => {
    const result = await run("control");
    assert.equal(result.before.quoteChars, 839);
    assert.deepEqual(result.errors, []);
    assert.equal(result.inserted, true);
    assert.equal(result.stillVisible, true);
  });
  await t.test("a 41-line quote remains stable when React inserts a sibling", async () => {
    const result = await run("quote");
    assert.equal(result.before.marks, 1, JSON.stringify(result));
    assert.equal(result.before.originalLastNodeConnected, true, JSON.stringify(result));
    assert.deepEqual(result.errors, [], JSON.stringify(result));
    assert.equal(result.inserted, true, JSON.stringify(result));
    assert.equal(result.stillVisible, true, JSON.stringify(result));
  });
  await t.test("a message without quotes keeps its adjacent text nodes valid", async () => {
    const result = await run("empty");
    assert.equal(result.before.children, 2, JSON.stringify(result));
    assert.equal(result.before.originalLastNodeConnected, true, JSON.stringify(result));
    assert.deepEqual(result.errors, [], JSON.stringify(result));
    assert.equal(result.inserted, true, JSON.stringify(result));
    assert.equal(result.stillVisible, true, JSON.stringify(result));
  });

  await t.test("quote and search overlays preserve interactions, updates, and nested scrolling", async () => {
    await page.evaluate(() => {
      const React = window.fixtureModules.react;
      const { flushSync } = window.fixtureModules["react-dom"];
      const { createRoot } = window.fixtureModules["react-dom/client"];
      const quoteText = Array.from({ length: 41 }, (_, i) => `${String(i).padStart(2, "0")} ${"x".repeat(i < 20 ? 17 : 16)}`).join("\n");
      const quote = { id: "quote", text: quoteText, sourceEntryId: "fixture" };
      window.fixtureEvents = { clicks: 0, hovers: 0, linkClicks: 0, errors: [] };
      function Fixture() {
        const host = React.useRef(null), content = React.useRef(null);
        const [inserted, setInserted] = React.useState(false);
        const [quotes, setQuotes] = React.useState([]), [searchRanges, setSearchRanges] = React.useState([]);
        window.fixtureUpdate = () => flushSync(() => setInserted(true));
        React.useLayoutEffect(() => {
          setQuotes(window.fixtureFindQuoteHighlights(content.current, [quote]));
          const node = content.current.querySelector("a").firstChild;
          const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 3);
          setSearchRanges([range]);
        }, [inserted]);
        return React.createElement("div", { ref: host, id: "fixture-host", style: { position: "relative", width: 360 } },
          React.createElement("section", { ref: content, id: "fixture-content", "data-chat-message-row": "true", "data-entry-id": "fixture" },
            React.createElement("p", { style: { whiteSpace: "pre-wrap" } },
              React.createElement("a", { href: "#", onClick: (event) => { event.preventDefault(); window.fixtureEvents.linkClicks++; } }, "prefix"),
              inserted ? React.createElement("b", { "data-inserted": "true" }, "new") : null, quoteText)),
          React.createElement(window.fixtureLayer, { hostRef: host, contentRef: content, quotes, searchRanges, flashingQuoteId: null,
            onBadgeClick: () => { window.fixtureEvents.clicks++; }, onBadgeHover: () => { window.fixtureEvents.hovers++; }, onBadgeLeave() {} }));
      }
      const container = document.createElement("div"); document.body.appendChild(container);
      window.fixtureRoot = createRoot(container, { onUncaughtError: (error) => window.fixtureEvents.errors.push(error.name) });
      flushSync(() => window.fixtureRoot.render(React.createElement(Fixture)));
    });
    await page.waitForSelector('[data-reader-quote-badge="true"]');
    assert.ok(await page.locator('[data-reader-quote-mark="true"]').count() >= 41);
    assert.equal(await page.locator('[data-session-search-match="true"]').count(), 1);
    await page.getByRole("button", { name: "编辑引用 1" }).click();
    await page.getByText("prefix", { exact: true }).click();
    assert.deepEqual(await page.evaluate(() => ({ clicks: window.fixtureEvents.clicks, linkClicks: window.fixtureEvents.linkClicks })),
      { clicks: 1, linkClicks: 1 });
    await page.evaluate(() => window.fixtureUpdate());
    await page.waitForSelector('[data-inserted="true"]');
    assert.deepEqual(await page.evaluate(() => window.fixtureEvents.errors), []);
    assert.equal(await page.locator("#fixture-content").innerText().then((text) => text.includes("prefixnew")), true);
    await page.evaluate(() => { const content = document.getElementById("fixture-content"); content.style.height = "48px"; content.style.overflow = "auto"; });
    await page.waitForFunction(() => !document.querySelector('[data-reader-quote-badge="true"]'));
    await page.evaluate(() => { const content = document.getElementById("fixture-content"); content.scrollTop = content.scrollHeight; });
    await page.waitForSelector('[data-reader-quote-badge="true"]');
    await page.evaluate(() => window.fixtureRoot.unmount());
  });
});
