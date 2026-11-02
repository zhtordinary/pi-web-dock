import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);

test("number-only quote chips expose one header delete action through hover and keyboard focus", async () => {
  const source = await readFile(new URL("./QuoteCardGroup.tsx", import.meta.url), "utf8");
  const states = [];
  const timers = new Map();
  const removed = [];
  const jumped = [];
  const edited = [];
  let hook = 0;
  const cjsModule = { exports: {} };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS,
  } }).outputText, {
    module: cjsModule, exports: cjsModule.exports,
    require(name) {
      if (name === "react") return {
        useState: initial => [hook++ === 2 ? "first" : initial, value => states.push(value)],
        useRef: value => ({ current: value }), useEffect() {}, useCallback: fn => fn,
      };
      if (name === "@/lib/quote-context") return { getQuotePreviewMaxHeight: () => 0 };
      if (name === "@/hooks/useI18n") return { useI18n: () => ({ t: key => key }) };
      if (name === "lucide-react") return { X: "svg", Pencil: "svg", Trash2: "svg", Check: "svg" };
      return require(name);
    },
    setTimeout: fn => { const id = Symbol(); timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const quotes = [
    { id: "first", text: "原文\n代码与长链接", reply: "我的评论\n保留换行" },
    { id: "second", text: "另一段原文", reply: "另一条评论" },
  ];
  const tree = cjsModule.exports.QuoteCardGroup({ quotes,
    onRemoveQuote: id => removed.push(id), onJumpToQuote: id => jumped.push(id),
    onEditQuote: quote => edited.push(quote),
  });
  const nodes = [];
  function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    nodes.push(node);
    walk(node.props?.children);
  }
  walk(tree);
  const chips = nodes.filter(node => node.props["aria-label"] === "quote.badgeLabel");
  assert.equal(chips.length, 2);
  assert.equal(chips[0].props.children.type, "span", "chip contains only its numbered badge");
  for (const chip of chips) {
    assert.equal(chip.props.style.background, undefined, "numbered badges have no outer pill background");
    assert.equal(chip.props.style.border, undefined, "numbered badges have no outer pill border");
    assert.equal(chip.props.style.padding, "3px 0", "chips add no horizontal shell around their badge");
  }
  chips[0].props.onClick();
  chips[1].props.onKeyDown({ key: "Enter", preventDefault() {} });
  assert.deepEqual(jumped, ["first", "second"]);

  const wrapper = nodes.find(node => node.props.onFocus && node.props.draggable);
  wrapper.props.onFocus();
  assert.equal(states.at(-1), "first", "keyboard focus opens the preview");
  wrapper.props.onBlur({ currentTarget: { contains: () => true }, relatedTarget: {} });
  assert.equal(timers.size, 0, "moving focus into preview controls keeps it open");
  wrapper.props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null });
  assert.equal(timers.size, 1, "leaving the preview schedules dismissal");

  const deleteButtons = nodes.filter(node => node.props.className === "quote-delete-button");
  const header = nodes.find(node => node.props.className === "quote-preview-actions");
  assert.equal(deleteButtons.length, 1, "deletion lives only in the open preview header");
  assert.equal(header.props.style.width, "max-content");
  assert.equal(header.props.style.gap, 2);
  assert.equal(deleteButtons[0].props.style.width, 28);
  assert.equal(deleteButtons[0].props.style.boxSizing, "border-box");
  deleteButtons[0].props.onClick({ stopPropagation() {} });
  assert.deepEqual(removed, ["first"], "only the selected quote is removed");
  nodes.find(node => node.props.title === "quote.reEdit").props.onClick({ stopPropagation() {} });
  assert.deepEqual(edited, [quotes[0]]);
  assert.equal(nodes.find(node => node.props.className === "quote-preview-source").props.children, quotes[0].text);
  const commentText = nodes.find(node => node.props.className === "quote-preview-comment-text");
  assert.equal(commentText.props.children, quotes[0].reply);
  assert.equal(commentText.type, "span", "reply text flows beside its inline label");
  const label = nodes.find(node => node.props.className === "quote-preview-comment-label");
  assert.equal(label.type, "span");
  assert.equal(label.props.children, "Reply:");
  const content = nodes.find(node => node.props.className === "quote-preview-content");
  const popover = nodes.find(node => Array.isArray(node.props.children) && node.props.children.includes(header));
  assert.ok(popover.props.children.includes(content), "fixed actions and scrollable content are siblings");
  assert.equal(popover.props.style.maxHeight, "var(--quote-preview-max-height, calc(100dvh - 24px))");
  assert.equal(popover.props.style.overflowY, "auto");
  assert.equal(popover.props.style.overflowX, "hidden");
  assert.equal(popover.props.style.flexDirection, "column");
  assert.ok(header.props.children.includes(deleteButtons[0]), "delete action stays in the fixed header");
});

test("all quote deletion surfaces share red default, hover and keyboard-focus styling", async () => {
  for (const path of ["QuoteCardGroup.tsx", "ChatWindow.tsx", "QuoteAnnotationModal.tsx"]) {
    const source = await readFile(new URL(`./${path}`, import.meta.url), "utf8");
    assert.equal(source.match(/className="quote-delete-button"/g)?.length, 1, path);
  }
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.quote-delete-button\s*\{[^}]*color: var\(--danger, light-dark\(#dc2626, #f87171\)\)/s);
  assert.match(css, /\.quote-delete-button:hover,\s*\.quote-delete-button:focus-visible/);
  assert.match(css, /\.quote-delete-button:focus-visible\s*\{[^}]*outline: 2px solid currentColor/s);
});
