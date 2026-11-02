import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";

type Listener = { changed(): void; failed(error: Error): void };
type FileWatch = { listeners: Set<Listener>; close(): void };
const key = Symbol.for("pi-web.session-file-watchers");
const watchers = ((globalThis as Record<symbol, unknown>)[key] ??= new Map()) as Map<string, FileWatch>;

/** Share one event-driven observer per resolved session path; never create the file. */
export function subscribeSessionFileChanges(filePath: string, changed: () => void, failed: (error: Error) => void): () => void {
  const identity = resolve(filePath);
  let state = watchers.get(identity);
  if (!state) {
    const listeners = new Set<Listener>();
    const targetDirectory = dirname(identity);
    let watcher: FSWatcher | undefined, directory = "", closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fingerprint = () => {
      try {
        const stat = statSync(identity, { bigint: true });
        return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    };
    let previous = fingerprint();
    const fail = (error: unknown) => {
      for (const listener of [...listeners]) listener.failed(error instanceof Error ? error : new Error(String(error)));
    };
    const flush = () => {
      timer = undefined;
      if (closed) return;
      try {
        attach();
        const current = fingerprint();
        if (current === previous) return;
        previous = current;
        for (const listener of [...listeners]) listener.changed();
        if (current === null) fail(new Error("Session history moved or was removed"));
      } catch (error) { fail(error); }
    };
    function attach() {
      let next = targetDirectory;
      while (!existsSync(next) && dirname(next) !== next) next = dirname(next);
      if (watcher && next === directory) return;
      watcher?.close();
      directory = next;
      watcher = watch(directory, { persistent: false }, (_event, filename) => {
        if (closed) return;
        const expected = directory === targetDirectory ? basename(identity) : relative(directory, targetDirectory).split(sep)[0];
        if (filename && filename.toString() !== expected) return;
        if (!timer) { timer = setTimeout(flush, 50); timer.unref(); }
      });
      watcher.on("error", fail);
    }
    attach();
    state = { listeners, close: () => { closed = true; watcher?.close(); if (timer) clearTimeout(timer); } };
    watchers.set(identity, state);
  }
  const listener = { changed, failed };
  const current = state;
  current.listeners.add(listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) { current.close(); watchers.delete(identity); }
  };
}
