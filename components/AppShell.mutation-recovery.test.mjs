import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
const source = readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");
const handler = source.slice(source.indexOf("  const mutateRemoteSession ="), source.indexOf("  useEffect(() => {\n    void fetchSessionActivity", source.indexOf("  const mutateRemoteSession =")));

test("ordinary mutation submission does not auto-expand recovery; only unresolved, prior or error paths do", () => {
  const requestStart = handler.indexOf("    try {\n      const target = new URL(device.url)");
  const receipt = handler.indexOf("      const receipt = await getRemoteMutationClient()");
  assert.ok(requestStart > 0 && receipt > requestStart);
  assert.doesNotMatch(handler.slice(requestStart, receipt), /setMutationRecoveryOpen\(true\)/);
  const completed = handler.slice(handler.indexOf('      if (receipt.status === "completed")'), handler.indexOf("      setMutationRecoveryOpen(true);", handler.indexOf('      if (receipt.status === "completed")')));
  assert.match(completed, /snapshot\(\)\.length\) setMutationRecoveryOpen\(false\)/);
  assert.doesNotMatch(completed, /setMutationRecoveryOpen\(true\)/);
  assert.match(handler, /if \(receipt.previousOperation\) \{\s*setMutationRecoveryOpen\(true\)/);
});

test("incomplete discovery keeps a visible recovery status", () => {
  assert.match(source, /setMutationRecoveryIncomplete\(!response.ok \|\| recovered.unavailableTargets.length > 0\)/);
  assert.match(source, /mutationRecoveryIncomplete && <p role="status">\{translate\("mutationRecovery.incomplete"\)\}/);
  assert.doesNotMatch(source, /mutationRecovery\.empty/);
  assert.match(source, /href=\{remoteMutationLink\} target="_blank" rel="noopener noreferrer"/);
});

test("empty recovery stays out of the normal UI", () => {
  assert.match(source, /const mutationRecoveryVisible = pendingRemoteMutations\.length > 0\s*\|\| Boolean\(mutationRecoveryOpen && \(remoteMutationNotice \|\| mutationRecoveryBusy\)\);/);
  assert.match(source, /\{mutationRecoveryVisible && \(\s*<details className="remote-mutation-recovery"/);
});

test("all mutation recovery labels and action/status keys exist in all three languages", async () => {
  const jiti = createJiti(import.meta.url);
  const keys = [...source.matchAll(/translate\("(mutationRecovery\.[^"]+)"/g)].map(match => match[1]);
  keys.push(...["rename", "archive", "unarchive", "delete"].map(value => `mutationRecovery.action.${value}`),
    ...["accepted", "running", "unknown", "not_found", "completed", "failed", "conflict"].map(value => `mutationRecovery.status.${value}`),
    ...["upgrade", "unavailable", "recoveryUnavailable", "storageUnavailable", "notSent"].map(value => `mutationRecovery.${value}`));
  for (const [file, name] of [["en", "enLocale"], ["zh-CN", "zhCNLocale"], ["zh-TW", "zhTWLocale"]]) {
    const locale = (await jiti.import(`../lib/i18n/messages/${file}.ts`))[name];
    for (const key of keys) assert.ok(locale.messages[key], `${file}: missing ${key}`);
  }
});

test("refresh clears stale operation notices before observing current availability", () => {
  const refresh=source.slice(source.indexOf("  const refreshRemoteMutationRecovery ="),source.indexOf("  useEffect(() => {",source.indexOf("  const refreshRemoteMutationRecovery =")));
  assert.ok(refresh.indexOf("setRemoteMutationNotice(null)")<refresh.indexOf("await fetch("));
  assert.match(refresh,/setMutationRecoveryIncomplete\(!response.ok \|\| recovered.unavailableTargets.length > 0\)/);
  assert.match(source,/if \(receipt.refreshUnavailable\) \{\s*setMutationRecoveryIncomplete\(true\);\s*setRemoteMutationNotice\(translate\("mutationRecovery.refreshFailed"\)\);\s*return;/);
});

test("rendered recovery exposes an explicit original-command continuation only for known absent receipts", async () => {
  const require = createRequire(import.meta.url), React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const ts = (await import("typescript")).default;
  const tree = ts.createSourceFile("AppShell.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let panel;
  const visit = node => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === "details"
      && node.openingElement.attributes.getText(tree).includes('className="remote-mutation-recovery"')) panel = node;
    ts.forEachChild(node, visit);
  };
  visit(tree); assert.ok(panel);
  const names = ["mutationRecoveryOpen", "setMutationRecoveryOpen", "translate", "mutationRecoveryBusy", "pendingRemoteMutations",
    "remoteMutationNotice", "remoteMutationLink", "refreshRemoteMutationRecovery", "mutationRecoveryIncomplete", "mutationAuthenticationTargets",
    "queryRemoteMutation", "continueRemoteMutation", "reviewRemoteMutation"];
  const code = ts.transpileModule(`module.exports = function Recovery({${names.join(",")}}) { return (${panel.getText(tree)}); };`,
    { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
  const compiledModule = { exports: {} }; runInNewContext(code, { module: compiledModule, React });
  const command = { operationId: "saved-original", deviceId: "peer", sessionId: "deleted-session", op: "rename", name: "Original name", force: true };
  const calls = [], target = { id: "peer", name: "Remote", url: "https://peer.test" };
  const render = (status, extra = {}) => compiledModule.exports({ mutationRecoveryOpen: true, setMutationRecoveryOpen() {}, translate: key => key,
    mutationRecoveryBusy: false, mutationAuthenticationTargets: [], remoteMutationNotice: null, remoteMutationLink: null, refreshRemoteMutationRecovery() {}, mutationRecoveryIncomplete: false,
    pendingRemoteMutations: [{ command, target, receipt: { ...command, status }, ...extra }],
    queryRemoteMutation() {}, reviewRemoteMutation() {}, continueRemoteMutation: item => calls.push(item) });
  const buttons = node => !React.isValidElement(node) ? [] : [...(node.type === "button" ? [node] : []), ...React.Children.toArray(node.props.children).flatMap(buttons)];
  const absent = render("not_found");
  const continuation = buttons(absent).find(button => button.props.children === "mutationRecovery.continueOriginal");
  assert.ok(continuation); assert.equal(continuation.props.disabled, undefined);
  continuation.props.onClick(); assert.equal(calls.length, 1); assert.deepEqual(calls[0].command, command);
  const html = renderToStaticMarkup(absent);
  assert.match(html, /Original name/); assert.match(html, /mutationRecovery.force/); assert.match(html, /mutationRecovery.continueHint/);
  assert.doesNotMatch(html, /mutationRecovery.review</, "a nonexistent server receipt cannot be acknowledged away");
  assert.equal(buttons(render("not_found", { busy: true })).find(button => button.props.children === "mutationRecovery.continueOriginal").props.disabled, true);
  for (const status of ["unknown", "accepted", "running", "completed", "failed", "conflict"]) {
    assert.doesNotMatch(renderToStaticMarkup(render(status)), /mutationRecovery.continueOriginal/);
  }
  assert.doesNotMatch(renderToStaticMarkup(render("not_found", { actionKnown: false })), /mutationRecovery.continueOriginal/);
  const handler = source.slice(source.indexOf("  const continueRemoteMutation ="), source.indexOf("  // Recovery owns the original operation"));
  assert.match(handler, /\.continueOriginal\(item.command.operationId, item.target.id\)/);
  assert.doesNotMatch(handler, /crypto.randomUUID|mutateRemoteSession\(|getRemoteMutationClient\(\)\(/);
});

test("recovery is a bounded in-flow sibling of the flexible Reader shell, not a composer overlay", async () => {
  const ts = (await import("typescript")).default;
  const tree = ts.createSourceFile("AppShell.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const className = node => node.openingElement?.attributes.properties.find(property => property.name?.text === "className")?.initializer?.getText(tree) ?? "";
  let viewport;
  const visit = node => { if (ts.isJsxElement(node) && className(node) === '"app-viewport"') viewport = node; ts.forEachChild(node, visit); };
  visit(tree); assert.ok(viewport, "one viewport owns both shell and recovery height");
  const shell = viewport.children.find(node => ts.isJsxElement(node) && className(node).includes("app-shell"));
  assert.ok(shell);
  assert.match(className(shell), /app-shell.*layout-reader/);
  assert.match(viewport.getText(tree), /mutationRecoveryVisible &&/);
  let recovery;
  const visitRecovery = node => {
    if (ts.isJsxElement(node) && className(node) === '"remote-mutation-recovery"') recovery = node;
    ts.forEachChild(node, visitRecovery);
  };
  visitRecovery(viewport);
  assert.ok(recovery);
  assert.equal(recovery.openingElement.tagName.getText(tree), "details");
  assert.equal(className(recovery), '"remote-mutation-recovery"');
  const style = node => node.openingElement.attributes.properties.find(property => property.name?.text === "style").initializer.getText(tree);
  assert.match(style(viewport), /flexDirection: "column"/);
  assert.match(style(viewport), /height: "var\(--app-viewport-height, 100dvh\)"/);
  assert.match(style(shell), /flex: 1/); assert.match(style(shell), /minHeight: 0/);
  assert.doesNotMatch(style(shell), /\bheight:/, "shell consumes only viewport space left by recovery");
  assert.match(style(shell), /paddingLeft: "env\(safe-area-inset-left\)"/);
  assert.match(style(shell), /paddingRight: "env\(safe-area-inset-right\)"/);
  assert.match(style(recovery), /flexShrink: 0/);
  assert.match(style(recovery), /maxHeight: "min\(35%, 260px\)"/);
  assert.match(style(recovery), /overflowY: "auto"/);
  assert.match(style(recovery), /overflowWrap: "anywhere"/);
  assert.match(style(recovery), /paddingBottom: "max\(6px, env\(safe-area-inset-bottom\)\)"/);
  assert.doesNotMatch(style(recovery), /\b(position|bottom|right|zIndex|height):/, "no overlay positioning or fixed expanded height");
  assert.match(style(recovery), /padding: "6px 12px"/, "collapsed recovery remains a compact summary row");
});

test("authentication failures reach visible target-page guidance without navigating or clearing unknown operations", async () => {
  const ts = (await import("typescript")).default;
  const tree = ts.createSourceFile("AppShell.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Set(["showRemoteMutationAuthentication", "queryRemoteMutation", "continueRemoteMutation", "reviewRemoteMutation", "mutateRemoteSession"]);
  const statements = [];
  const visit = node => {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(item => names.has(item.name.getText(tree)))) statements.push(node.getText(tree));
    ts.forEachChild(node, visit);
  };
  visit(tree); assert.equal(statements.length, names.size);
  const calls = [];
  const target = { id: "peer", url: "https://target.example" };
  const receipt = { status: "unknown", operationId: "original-id", authenticationRequired: true };
  const remote = Object.assign(async () => ({ ...receipt, notSent: true }), {
    query: async () => receipt, continueOriginal: async () => ({ ...receipt, notSent: true }),
    review: async () => { throw Object.assign(new Error("auth required"), { code: "AUTH_REQUIRED" }); },
  });
  const ctx = { useCallback: fn => fn, translate: key => key, URL,
    getRemoteMutationClient: () => remote, isSessionMutationBridgeAuthenticationRequired: error => error.code === "AUTH_REQUIRED",
    setRemoteMutationLink: value => calls.push(["link", value]), setRemoteMutationNotice: value => calls.push(["notice", value]),
    setMutationRecoveryIncomplete: value => calls.push(["incomplete", value]), setMutationRecoveryOpen: value => calls.push(["open", value]),
    clearSessionActivityCache: () => { throw Error("must not clear workspace state"); }, setRefreshKey: () => { throw Error("must not refresh optimistic state"); },
    window: { confirm: () => true }, module: { exports: {} },
  };
  const code = ts.transpileModule(`${statements.join("\n")}\nmodule.exports = {${[...names].join(",")}};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, ctx);
  const item = { target, command: { operationId: "original-id" } };
  for (const callback of [() => ctx.module.exports.queryRemoteMutation(item), () => ctx.module.exports.continueRemoteMutation(item),
    () => ctx.module.exports.reviewRemoteMutation(item), () => ctx.module.exports.mutateRemoteSession(target, "delete", "session")]) {
    calls.length = 0; await callback();
    assert.ok(calls.some(([key, value]) => key === "link" && value === target.url));
    assert.ok(calls.some(([key, value]) => key === "notice" && value?.includes("mutationRecovery.authenticationRequired")));
    assert.ok(calls.some(([key, value]) => key === "open" && value === true));
  }
  assert.doesNotMatch(statements.join("\n"), /window\.open|location\.(?:href|replace|assign)|iframe\.src/);
  for (const file of ["en", "zh-CN", "zh-TW"]) {
    const text = readFileSync(new URL(`../lib/i18n/messages/${file}.ts`, import.meta.url), "utf8");
    assert.match(text, /mutationRecovery.authenticationRequired/);
  }
});
