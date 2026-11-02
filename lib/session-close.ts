import { getRpcSession, getRpcSessionTree } from "./rpc-manager";
import { zhCNLocale } from "./i18n/messages/zh-CN.ts";
import { getSessionBackgroundRunIds } from "./subagent-activity";
import { acquireStateWriteLock } from "./state-file-transaction";

/** Closure refuses all owned work, including children whose files move with the parent. */
export async function closeIdleSession(sessionId: string, sessionFile: string): Promise<void> {
  const parent = getRpcSession(sessionId);
  const runtimes = [...new Set([...(parent?.isAlive() ? [parent] : []), ...getRpcSessionTree(sessionFile)])];
  const identities = [{ id: sessionId, path: sessionFile }, ...runtimes.map(rpc => ({ id: rpc.sessionId, path: rpc.sessionFile }))];
  for (const identity of identities) {
    const background = getSessionBackgroundRunIds(identity);
    if (background.length) throw Object.assign(new Error(`Session has active background tasks: ${background.join(", ")}`), { code: "session_busy" });
  }
  for (const rpc of runtimes) {
    const execution = rpc.getExecutionState();
    if (rpc.isRunning() || execution.active || execution.queuedCount > 0) {
      throw Object.assign(new Error("Session is busy; stop its execution and recall queued messages before archiving"), { code: "session_busy" });
    }
    if (rpc.hasActiveSideAsk()) {
      throw Object.assign(new Error(zhCNLocale.messages["sessionActivity.sideAskPreventsArchive"]), { code: "session_busy" });
    }
  }
  for (const rpc of runtimes) {
    rpc.setUnattendedEnabled(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([rpc.shutdown(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Session shutdown not confirmed")), 10_000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
    // UI disposal can finish before the last native writer releases ownership.
    const release = acquireStateWriteLock(rpc.sessionFile);
    release();
  }
}
