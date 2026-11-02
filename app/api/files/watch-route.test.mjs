import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./[...path]/route.ts", import.meta.url), "utf8");
const start = source.indexOf('if (type === "watch")');
const end = source.indexOf("// type === \"list\"", start);
assert.notEqual(start, -1, "watch route not found");
assert.notEqual(end, -1, "watch route end not found");
const watchBlock = source.slice(start, end);

function watchFixture({ aborted = false, abortDuringWatch = false, failWatch = false, failEnqueue = false } = {}) {
  const abort = new AbortController();
  if (aborted) abort.abort();
  const state = { watches: 0, closes: 0, controllerCloses: 0, events: [], statCalls: 0 };
  const watcher = {
    close() { state.closes += 1; },
    on(type, callback) { if (type === "error") state.onError = callback; },
  };
  class FakeReadableStream {
    constructor(underlying) {
      this.underlying = underlying;
      underlying.start({
        enqueue(chunk) {
          if (failEnqueue) throw new Error("disconnected");
          state.events.push(new TextDecoder().decode(chunk));
        },
        close() { state.controllerCloses += 1; },
      });
    }
    cancel() { this.underlying.cancel(); }
  }
  class FakeResponse {
    constructor(body, init) { this.body = body; this.headers = init.headers; }
  }
  const context = {
    type: "watch", filePath: "/workspace/file.txt", path, TextEncoder,
    request: { signal: abort.signal },
    stat: { isFile: () => true, mtimeMs: 1, ctimeMs: 1, ino: 1, size: 1 },
    samePath: (a, b) => a === b,
    fs: {
      watch(_directory, callback) {
        state.watches += 1;
        state.change = callback;
        if (abortDuringWatch) abort.abort();
        if (failWatch) throw new Error("watch failed");
        return watcher;
      },
      statSync() { state.statCalls += 1; throw new Error("missing"); },
    },
    ReadableStream: FakeReadableStream, Response: FakeResponse,
  };
  vm.runInNewContext(stripTypeScriptTypes(`function run() { ${watchBlock} }\nglobalThis.run = run;`), context);
  const response = context.run();
  return { state, abort, response };
}

test("watch cleanup handles pre-abort, abort, cancellation, and late callbacks once", () => {
  const pre = watchFixture({ aborted: true });
  assert.equal(pre.state.watches, 0);
  assert.equal(pre.state.controllerCloses, 1);
  pre.response.body.cancel();
  assert.equal(pre.state.controllerCloses, 1);

  const active = watchFixture();
  assert.match(active.state.events[0], /^event: connected/);
  active.abort.abort();
  active.response.body.cancel();
  active.state.onError();
  active.state.change("change", "file.txt");
  assert.equal(active.state.closes, 1);
  assert.equal(active.state.controllerCloses, 1);
  assert.equal(active.state.statCalls, 0);
  assert.equal(active.state.events.length, 1);

  const cancelled = watchFixture();
  cancelled.response.body.cancel();
  cancelled.abort.abort();
  assert.equal(cancelled.state.closes, 1);
  assert.equal(cancelled.state.controllerCloses, 0);
});

test("watch cleanup handles watcher errors, enqueue failures and startup races", () => {
  const error = watchFixture();
  error.state.onError();
  error.state.onError();
  assert.equal(error.state.closes, 1);
  assert.equal(error.state.controllerCloses, 1);
  const enqueue = watchFixture({ failEnqueue: true });
  assert.equal(enqueue.state.closes, 1);
  assert.equal(enqueue.state.controllerCloses, 1);
  const failed = watchFixture({ failWatch: true });
  assert.match(failed.state.events[0], /^event: error/);
  assert.equal(failed.state.closes, 0);
  assert.equal(failed.state.controllerCloses, 1);
  const raced = watchFixture({ abortDuringWatch: true });
  assert.equal(raced.state.closes, 1);
  assert.equal(raced.state.controllerCloses, 1);
  assert.equal(raced.state.events.length, 0);
});

test("file watching survives same-path replacement", () => {
  assert.match(watchBlock, /watcher = fs\.watch\(watchedDirectory/);
  assert.match(watchBlock, /samePath\(path\.join\(watchedDirectory, changedName\.toString\(\)\), filePath\)/);
  assert.match(watchBlock, /s\.ctimeMs === lastCtimeMs/);
  assert.match(watchBlock, /s\.ino === lastIno/);
  assert.match(watchBlock, /lastExists/);
});

test("a missing target can be watched after its parent is authorized", () => {
  assert.match(source, /if \(type !== "watch"\)[\s\S]*error: "Not found"/);
  assert.match(source, /const existingAuthorizationPath = stat \? filePath : path\.dirname\(filePath\)/);
  assert.match(watchBlock, /lastExists = stat !== undefined/);
});

test("connected is emitted only after the watcher exists", () => {
  const watcher = watchBlock.indexOf("watcher = fs.watch");
  const connected = watchBlock.indexOf('send("connected"');
  assert.ok(watcher >= 0, "watcher creation missing");
  assert.ok(connected > watcher, "connected emitted before watcher creation");
});
