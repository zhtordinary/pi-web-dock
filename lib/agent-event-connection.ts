import type { AgentEventLike } from "./agent-event-wire";

export interface AgentEventSourceLike {
  readonly readyState: number;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

export type AgentEventConnectionStatus = "ready_timeout" | "startup_error" | "closed";

export class AgentEventConnectionError extends Error {
  constructor(public readonly status: AgentEventConnectionStatus, message?: string) {
    super(message ?? (
      status === "ready_timeout"
        ? "Timed out connecting to the session event stream. Please try again."
        : "Failed to connect to the agent event stream. Please try again."
    ));
    this.name = "AgentEventConnectionError";
  }
}

type Attempt = {
  promise: Promise<void>;
  ready: boolean;
  succeed(): void;
  fail(error: AgentEventConnectionError): void;
};

type Connection = {
  sessionId: string;
  source: AgentEventSourceLike;
  attempt: Attempt;
  runtimeAvailable?: boolean;
  /**
   * Watchdog for a connection that is OPEN but silent. A dead TCP path, a
   * suspended server or a stalled proxy keeps EventSource in OPEN, so `onerror`
   * never fires and the client would wait forever without a completion event.
   */
  watchdog: ReturnType<typeof setTimeout> | null;
};

export interface AgentEventConnectionOptions {
  createSource(sessionId: string): AgentEventSourceLike;
  onEvent(event: AgentEventLike): void;
  shouldMaintain(sessionId: string): boolean;
  readinessTimeoutMs: number;
  reconnectDelayMs: number;
  /**
   * How long a ready connection may stay silent before it is reopened. The
   * server sends a heartbeat data event well inside this window; a silent stream
   * therefore means the path, not the agent, is idle.
   */
  silenceTimeoutMs?: number;
  onUnexpectedError?(error: unknown): void;
}

const EVENT_SOURCE_OPEN = 1;
const EVENT_SOURCE_CLOSED = 2;

/**
 * The server sends a heartbeat data event every 30 s. A ready stream that stays
 * silent for well over that means the connection is dead in a way EventSource
 * does not report: browsers keep OPEN through a stalled proxy or a sleeping
 * server. Reconnecting is safe because the stream replays the facts the client
 * needs and every event is idempotent by entry identity.
 */
const DEFAULT_SILENCE_TIMEOUT_MS = 90_000;

/** Owns selected-session observation, native readiness, and disconnect recovery. */
export class AgentEventConnection {
  private current: Connection | null = null;
  private retry: { sessionId: string; timer: ReturnType<typeof setTimeout> } | null = null;
  private retryGeneration = 0;

  constructor(private readonly options: AgentEventConnectionOptions) {}

  close(): void {
    this.stopRetrying();
    if (this.current) this.discard(this.current, new AgentEventConnectionError("closed"));
  }

  maintain(sessionId: string): void {
    if (!this.options.shouldMaintain(sessionId)) return;
    const retryGeneration = this.retryGeneration;
    void this.ensureConnected(sessionId).catch((error) => {
      if (retryGeneration !== this.retryGeneration) return;
      if (error instanceof AgentEventConnectionError) {
        if (error.status === "startup_error") this.stopRetrying();
        else this.scheduleRetry(sessionId);
      } else {
        this.options.onUnexpectedError?.(error);
      }
    });
  }

  async ensureConnected(sessionId: string): Promise<void> {
    while (true) {
      let connection = this.current;
      if (!connection || connection.sessionId !== sessionId) {
        connection = this.open(sessionId);
      } else if (
        connection.attempt.ready
        && connection.source.readyState === EVENT_SOURCE_OPEN
      ) {
        return;
      }

      await connection.attempt.promise;
      if (this.current !== connection) {
        if (this.current?.sessionId === sessionId) continue;
        throw new AgentEventConnectionError("closed");
      }
      if (connection.source.readyState === EVENT_SOURCE_OPEN) return;

      // A once-ready EventSource may otherwise remain CONNECTING indefinitely.
      this.discard(connection, new AgentEventConnectionError("closed"));
    }
  }

  async ensureRuntimeConnected(sessionId: string): Promise<void> {
    await this.ensureConnected(sessionId);
    if (this.current?.runtimeAvailable === false) this.close();
    await this.ensureConnected(sessionId);
    if (this.current?.runtimeAvailable !== true) {
      throw new AgentEventConnectionError("startup_error", "The native session event stream is not available. Please try again.");
    }
  }

  private open(sessionId: string): Connection {
    if (this.current) this.discard(this.current, new AgentEventConnectionError("closed"));

    let source: AgentEventSourceLike;
    try {
      source = this.options.createSource(sessionId);
    } catch (error) {
      throw new AgentEventConnectionError(
        "closed",
        error instanceof Error ? error.message : String(error),
      );
    }

    let settled = false;
    let resolve!: () => void;
    let reject!: (error: AgentEventConnectionError) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const timeout = setTimeout(() => {
      this.fail(connection, new AgentEventConnectionError("ready_timeout"));
    }, this.options.readinessTimeoutMs);
    const attempt: Attempt = {
      promise,
      ready: false,
      succeed() {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      },
      fail(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      },
    };
    const connection: Connection = { sessionId, source, attempt, watchdog: null };
    this.current = connection;

    const armWatchdog = () => {
      if (connection.watchdog !== null) clearTimeout(connection.watchdog);
      const silenceTimeoutMs = this.options.silenceTimeoutMs ?? DEFAULT_SILENCE_TIMEOUT_MS;
      if (silenceTimeoutMs <= 0) return;
      connection.watchdog = setTimeout(() => {
        connection.watchdog = null;
        if (this.current !== connection) return;
        // Same path as a reported transport error: discard and retry while the
        // session still has demand.
        this.fail(connection, new AgentEventConnectionError("closed"));
      }, silenceTimeoutMs);
      // A watchdog must never be the reason a page or test process stays alive.
      (connection.watchdog as unknown as { unref?: () => void }).unref?.();
    };

    source.onmessage = (message) => {
      if (this.current !== connection) return;
      let event: AgentEventLike;
      try {
        event = JSON.parse(message.data) as AgentEventLike;
      } catch {
        // A malformed frame still proves the path is alive.
        armWatchdog();
        return;
      }
      armWatchdog();

      if (event.type === "connected") {
        connection.runtimeAvailable = event.runtimeAvailable !== false;
        attempt.ready = true;
        attempt.succeed();
        this.stopRetrying();
      } else if (event.type === "startup_error") {
        const message = typeof event.errorMessage === "string" ? event.errorMessage : undefined;
        this.fail(connection, new AgentEventConnectionError("startup_error", message));
        return;
      }
      this.options.onEvent(event);
    };
    source.onerror = () => {
      const status = !attempt.ready && source.readyState === EVENT_SOURCE_CLOSED ? "startup_error" : "closed";
      this.fail(connection, new AgentEventConnectionError(status));
    };

    return connection;
  }

  private fail(connection: Connection, error: AgentEventConnectionError): void {
    if (this.current !== connection) return;
    this.discard(connection, error);
    if (error.status === "startup_error") this.stopRetrying();
    else this.scheduleRetry(connection.sessionId);
  }

  private discard(connection: Connection, error: AgentEventConnectionError): void {
    if (connection.watchdog !== null) {
      clearTimeout(connection.watchdog);
      connection.watchdog = null;
    }
    connection.attempt.fail(error);
    connection.source.close();
    if (this.current === connection) this.current = null;
  }

  private scheduleRetry(sessionId: string): void {
    if (!this.options.shouldMaintain(sessionId)) return;
    if (this.retry?.sessionId === sessionId) return;
    this.clearRetry();

    const timer = setTimeout(() => {
      if (this.retry?.timer !== timer) return;
      this.retry = null;
      this.maintain(sessionId);
    }, this.options.reconnectDelayMs);
    this.retry = { sessionId, timer };
  }

  private stopRetrying(): void {
    this.retryGeneration += 1;
    this.clearRetry();
  }

  private clearRetry(): void {
    if (this.retry) clearTimeout(this.retry.timer);
    this.retry = null;
  }
}
