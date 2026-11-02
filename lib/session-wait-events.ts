import { watch, existsSync, statSync, type FSWatcher } from "node:fs";
import { dirname, basename, relative, sep } from "node:path";
import { emitActivityEvent } from "./activity-events";
import { getSessionWaitStateRoot, getSessionWaitChannel } from "./session-waits";

type StateWatcher = { refs: number; close: () => void };
const key = Symbol.for("pi-web.session-wait-watchers");
const watchers: Map<string, StateWatcher> = ((globalThis as Record<symbol, unknown>)[key] ??= new Map()) as Map<string, StateWatcher>;

/** Observe atomic writes from both Reader and external wait workers; never create state. */
export function subscribeSessionWaitChanges(root = getSessionWaitStateRoot(), channel = getSessionWaitChannel()): () => void {
  const identity = `${root}:${channel}`;
  let state = watchers.get(identity);
  if (!state) {
    let watcher: FSWatcher | undefined, closed = false, pending = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const recover = () => {
      watcher?.close(); watcher = undefined;
      if (!closed && !retry) { retry = setTimeout(() => { retry = undefined; attach(); }, 1000); retry.unref(); }
    };
    const names = new Set([`${channel}.json`]);
    const fingerprint = () => {
      try { const stat = statSync(`${root}/${channel}.json`); return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; }
      catch { return "missing"; }
    };
    let previousFingerprint = fingerprint();
    function attach() {
      if (closed) return;
      watcher?.close();
      let directory = root;
      while (!existsSync(directory) && dirname(directory) !== directory) directory = dirname(directory);
      try {
        watcher = watch(directory, { persistent: false }, (_event, filename) => {
          if (filename && existsSync(root) && directory === root && !names.has(basename(filename.toString()))) return;
          if (filename && directory !== root && filename.toString() !== relative(directory, root).split(sep)[0]) return;
          if (pending) return;
          pending = true;
          queueMicrotask(() => {
            pending = false;
            if (closed) return;
            if ((directory !== root && existsSync(root)) || !existsSync(directory)) attach();
            const currentFingerprint = fingerprint();
            if (currentFingerprint === previousFingerprint) return;
            previousFingerprint = currentFingerprint;
            emitActivityEvent({ kind: "wait" });
          });
        });
        watcher.on("error", recover);
      } catch { recover(); }
    }
    attach();
    state = { refs: 0, close: () => { closed = true; watcher?.close(); if (retry) clearTimeout(retry); } };
    watchers.set(identity, state);
  }
  state.refs++;
  return () => {
    if (!state || state.refs <= 0) return;
    if (--state.refs === 0) { state.close(); watchers.delete(identity); }
    state = undefined;
  };
}
