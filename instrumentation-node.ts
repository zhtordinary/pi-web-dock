import { installExtensionProcessGuard } from "@/lib/extension-process-guard";
import { configureHttpDispatcher } from "@/lib/http-dispatcher";
import { closeAllAgentEventStreams } from "@/lib/agent-event-stream";
import { initializeSessionWaitRuntime } from "@/lib/session-waits";

export function registerNodeInstrumentation(): void {
  // First, before any session loads an extension: extensions share this process, and
  // a crash handler of theirs that throws must not end every other session with it.
  if (installExtensionProcessGuard()) console.log("[pi-web] extension process guard installed");
  configureHttpDispatcher();
  initializeSessionWaitRuntime();
  void import("@/lib/rpc-manager").then(({ initializeQuestionAnalysisRuntime }) => initializeQuestionAnalysisRuntime())
    .catch((error) => console.error("[pi-web] pending terminology startup recovery failed:", error));

  // In production Next 16 answers SIGINT/SIGTERM with server.close() and waits
  // for every connection to end, without a timeout. SSE streams only end when
  // the client disconnects, so close them here or the process never exits.
  const shutdownStreams = () => {
    closeAllAgentEventStreams();
  };
  process.on("SIGINT", shutdownStreams);
  process.on("SIGTERM", shutdownStreams);
}
