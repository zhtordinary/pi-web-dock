import type { EventEmitter } from "node:events";

// Reader runs every session's extensions inside one server process. An extension
// may register process-level crash handlers of its own: pi-lens, for example,
// rethrows every non-LSP error from its `unhandledRejection` and
// `uncaughtException` handlers. A handler that throws terminates the process
// (exit code 7), so one extension's unhandled rejection ended every session
// hosted by the process. Next.js itself logs these errors and keeps serving;
// this guard keeps that policy for handlers registered after it is installed:
// an error thrown by such a handler is logged and contained.

const GUARDED_EVENTS: ReadonlySet<string | symbol> = new Set(["uncaughtException", "unhandledRejection"]);
const INSTALLED = Symbol.for("pi-web.extension-process-guard");

type Listener = (...args: unknown[]) => unknown;
type Register = (this: EventEmitter, event: string | symbol, listener: Listener) => EventEmitter;
type Log = (message: string) => void;
type Guardable = EventEmitter & { [INSTALLED]?: true };

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

function describe(event: string | symbol, error: unknown): string {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  return `[pi-web] contained an error thrown by a ${String(event)} handler: ${detail}`;
}

/**
 * Wraps every `uncaughtException` / `unhandledRejection` listener registered on
 * `target` from now on. Listeners keep their identity for `off()` and
 * `listeners()`; listeners registered earlier (Next.js, Node) are untouched.
 * Returns false when the guard was already installed.
 */
export function installExtensionProcessGuard(
  target: EventEmitter = process,
  log: Log = (message) => console.error(message),
): boolean {
  const guardable = target as Guardable;
  if (guardable[INSTALLED]) return false;
  guardable[INSTALLED] = true;

  const report = (event: string | symbol, error: unknown): void => {
    try {
      log(describe(event, error));
    } catch {
      // Reporting must never become the error that ends the process.
    }
  };

  const contain = (event: string | symbol, listener: Listener, once: boolean): Listener => {
    const contained = function (this: unknown, ...args: unknown[]): void {
      // `once` is handled here rather than by EventEmitter, so that `off(listener)`
      // keeps matching the wrapper's single `.listener` level.
      if (once) target.removeListener(event, contained);
      try {
        const result = listener.apply(this, args);
        if (isThenable(result)) result.then(undefined, (error: unknown) => report(event, error));
      } catch (error) {
        report(event, error);
      }
    } as Listener & { listener: Listener };
    contained.listener = listener;
    return contained;
  };

  const intercept = (original: Register, once: boolean): Register =>
    function (this: EventEmitter, event, listener) {
      if (!GUARDED_EVENTS.has(event) || typeof listener !== "function") return original.call(this, event, listener);
      return original.call(this, event, contain(event, listener, once));
    };

  const append = target.on as Register;
  const prepend = target.prependListener as Register;
  target.on = intercept(append, false) as typeof target.on;
  target.addListener = target.on;
  target.once = intercept(append, true) as typeof target.once;
  target.prependListener = intercept(prepend, false) as typeof target.prependListener;
  target.prependOnceListener = intercept(prepend, true) as typeof target.prependOnceListener;
  return true;
}
