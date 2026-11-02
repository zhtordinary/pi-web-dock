import { watchRemoteSessionUi, type RemoteUiSnapshot } from "./session-control-remote";

type Target = { deviceId: string; sessionId: string };
type Watcher = { target: Target; controller: AbortController; snapshot: RemoteUiSnapshot | null; timer?: ReturnType<typeof setTimeout>; attempts: number };
const targetKey = (target: Target) => JSON.stringify([target.deviceId, target.sessionId]);

/** One event connection per remote target, shared by all its durable UI waits. */
export function createRemoteUiObservers(channel: string, onSnapshot: (target: Target, snapshot: RemoteUiSnapshot) => void, onChange: () => void) {
  const watchers = new Map<string, Watcher>();
  const connect = async (watcher: Watcher) => {
    try {
      await watchRemoteSessionUi(watcher.target.deviceId, watcher.target.sessionId, channel, watcher.controller.signal, snapshot => {
        watcher.snapshot = snapshot; watcher.attempts = 0;
        onSnapshot(watcher.target, snapshot);
        onChange();
      });
    } catch (error) {
      if (!watcher.controller.signal.aborted) console.warn("[session-wait] remote UI stream disconnected:", error instanceof Error ? error.message : String(error));
    } finally {
      watcher.snapshot = null;
      if (!watcher.controller.signal.aborted) {
        onChange();
        watcher.timer = setTimeout(() => { watcher.timer = undefined; void connect(watcher); }, Math.min(30_000, 1000 * 2 ** Math.min(watcher.attempts++, 5)));
        watcher.timer.unref?.();
      }
    }
  };
  const stop = (key: string, watcher: Watcher) => { watchers.delete(key); watcher.controller.abort(); if (watcher.timer) clearTimeout(watcher.timer); };
  return {
    sync(targets: Target[]) {
      const wanted = new Map(targets.map(target => [targetKey(target), target]));
      for (const [key, watcher] of watchers) if (!wanted.has(key)) stop(key, watcher);
      for (const [key, target] of wanted) if (!watchers.has(key)) {
        const watcher: Watcher = { target, controller: new AbortController(), snapshot: null, attempts: 0 };
        watchers.set(key, watcher); void connect(watcher);
      }
    },
    snapshot(target: Target) { return watchers.get(targetKey(target))?.snapshot ?? null; },
    close() { for (const [key, watcher] of watchers) stop(key, watcher); },
  };
}
