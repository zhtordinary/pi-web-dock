import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { constants, zstdCompress } from "node:zlib";
import WebSocket from "ws";
import { registerSessionResourceCleanup, type Model, type Api, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { streamSimple as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { createGrammarToolInputProperties } from "@earendil-works/pi-ai/api/constrained-sampling";
import { getDeclaredTools, normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { resolveHttpProxyUrlForTarget } from "@earendil-works/pi-ai/utils/node-http-proxy";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

const PROVIDER = "CPA GPT";
const COMPRESSION_THRESHOLD = 64 * 1024;
const IDLE_TIMEOUT = 300_000;
const SESSION_TTL = 300_000;
const MAX_SESSIONS = 32;
const TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const compress = promisify(zstdCompress);
type Payload = Record<string, unknown> & { input: unknown[] };
type Frame = Record<string, unknown> & { type?: string; response?: Record<string, unknown>; error?: { code?: string; message?: string } };
interface Continuation { parameters: string; input: string[]; responseId: string }
interface Exchange { channel: Channel; body: Payload; completed: boolean; inputItems: number; bodyBytes: number; reused: boolean; persistent: boolean }
interface TransportOptions {
  createSocket?: (url: string, options: WebSocket.ClientOptions) => WebSocket;
  sessionTtlMs?: number;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function parameters(body: Payload): string {
  const { input: _input, previous_response_id: _previous, ...rest } = body;
  return hash(rest);
}
function aborted(): Error { return new DOMException("Request was aborted", "AbortError"); }
function errorFrame(frame: Frame): Error {
  return new Error(JSON.stringify({ error: frame.error ?? frame.response?.error ?? { message: "CPA WebSocket request failed" } }));
}

/** One exclusive request at a time; an unowned or broken socket is never reused. */
class Channel {
  readonly socket: WebSocket;
  continuation?: Continuation;
  busy = true;
  failure?: Error;
  private queue: { frame: Frame; bytes: number }[] = [];
  private queuedBytes = 0;
  private wake?: () => void;
  private expiry?: ReturnType<typeof setTimeout>;
  private closing?: ReturnType<typeof setTimeout>;

  constructor(readonly sessionId: string | undefined, socket: WebSocket, readonly forget: () => void) {
    this.socket = socket;
    socket.on("error", () => this.fail(new Error("CPA WebSocket transport failed")));
    socket.on("close", (code) => {
      clearTimeout(this.closing);
      this.fail(new Error(`CPA WebSocket closed before completion (${code})`));
    });
    socket.on("message", (data, binary) => {
      try {
        if (binary) throw new Error("CPA returned a non-text WebSocket frame");
        const text = data.toString();
        this.queuedBytes += Buffer.byteLength(text);
        if (this.queuedBytes > 64 * 1024 * 1024) throw new Error("CPA WebSocket response queue exceeded 64 MiB");
        const frame: Frame = JSON.parse(text);
        if (!frame || typeof frame !== "object" || typeof frame.type !== "string") throw new Error("Invalid CPA WebSocket event");
        if (!this.busy) { this.close(); return; }
        this.queue.push({ frame, bytes: Buffer.byteLength(text) });
        this.wake?.();
      } catch {
        this.fail(new Error("Invalid CPA WebSocket response"));
        this.close();
      }
    });
  }

  fail(error: Error): void {
    this.failure ??= error;
    this.continuation = undefined;
    clearTimeout(this.expiry);
    this.forget();
    this.wake?.();
  }

  async open(signal?: AbortSignal | null): Promise<void> {
    if (signal?.aborted) throw aborted();
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.socket.off("open", onOpen);
        this.socket.off("error", onError);
        this.socket.off("close", onError);
        signal?.removeEventListener("abort", onAbort);
      };
      const onOpen = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(this.failure ?? new Error("CPA WebSocket handshake failed")); };
      const onAbort = () => { cleanup(); this.close(); reject(aborted()); };
      this.socket.once("open", onOpen);
      this.socket.once("error", onError);
      this.socket.once("close", onError);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  acquire(): void {
    clearTimeout(this.expiry);
    this.busy = true;
  }

  async next(signal: AbortSignal | null | undefined, timeoutMs: number): Promise<Frame> {
    for (;;) {
      if (signal?.aborted) throw aborted();
      const queued = this.queue.shift();
      if (queued) {
        this.queuedBytes -= queued.bytes;
        return queued.frame;
      }
      if (this.failure) throw this.failure;
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          this.wake = undefined;
        };
        const onAbort = () => { cleanup(); reject(aborted()); };
        this.wake = () => { cleanup(); resolve(); };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (timeoutMs > 0) timer = setTimeout(() => {
          cleanup(); reject(new Error("CPA WebSocket stream idle timeout"));
        }, timeoutMs);
      });
    }
  }

  release(ttlMs: number): void {
    this.busy = false;
    this.expiry = setTimeout(() => this.close(), ttlMs);
    this.expiry.unref?.();
  }

  close(): void {
    this.continuation = undefined;
    clearTimeout(this.expiry);
    this.forget();
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.close(1000, "reader-cpa-release");
      this.closing ??= setTimeout(() => this.socket.terminate(), 1_000);
      this.closing.unref?.();
    } else if (this.socket.readyState !== WebSocket.CLOSED) {
      this.socket.terminate();
    }
    this.fail(new Error("CPA WebSocket session was released"));
  }
}

/** Reader-owned transport only. Pi still builds requests and parses every result. */
export class CpaResponsesTransport {
  private readonly channels = new Map<string, Channel>();
  private readonly allChannels = new Set<Channel>();
  private readonly createSocket: NonNullable<TransportOptions["createSocket"]>;
  private readonly sessionTtlMs: number;
  private readonly unregisterCleanup: () => void;

  constructor(options: TransportOptions = {}) {
    this.createSocket = options.createSocket ?? ((url, settings) => new WebSocket(url, settings));
    this.sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL;
    this.unregisterCleanup = registerSessionResourceCleanup((sessionId) => this.closeSession(sessionId));
  }

  closeSession(sessionId?: string): void {
    for (const channel of this.allChannels) {
      if (sessionId === undefined || channel.sessionId === sessionId) channel.close();
    }
  }

  dispose(): void { this.closeSession(); this.unregisterCleanup(); }

  stream(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) {
    const responseModel = model as Model<"openai-responses">;
    if (model.provider !== PROVIDER || model.api !== "openai-responses") return streamResponses(responseModel, context, options);
    let exchange: Exchange | undefined;
    let httpOnly = options?.transport === "sse" || options?.cacheRetention === "none";
    const baseFetch = options?.fetch ?? globalThis.fetch;
    const idleMs = options?.timeoutMs ?? IDLE_TIMEOUT;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const endpoint = new URL(model.baseUrl.replace(/\/$/, "") + "/responses");
      if (request.method !== "POST" || request.url !== endpoint.href || request.headers.has("content-encoding")) return baseFetch(request);
      const text = await request.text();
      const body: Payload = JSON.parse(text);
      const full = new Request(request, { body: text });
      if (httpOnly || !Array.isArray(body.input) || body.stream !== true || body.background === true || body.previous_response_id !== undefined) {
        return this.http(baseFetch, full, text);
      }
      let acquired: { channel: Channel; reused: boolean; persistent: boolean };
      try {
        acquired = await this.acquire(endpoint, request.headers, model, options, request.signal);
      } catch (error) {
        if (request.signal.aborted) throw error;
        httpOnly = true; // Handshake failed before any response.create was sent.
        return this.http(baseFetch, full, text);
      }
      const { channel, reused, persistent } = acquired;
      let outgoing = body;
      const previous = channel.continuation;
      const useDelta = options?.transport !== "websocket";
      if (useDelta && previous && previous.parameters === parameters(body)
        && body.input.length >= previous.input.length
        && previous.input.every((value, index) => value === hash(body.input[index]))) {
        outgoing = { ...body, previous_response_id: previous.responseId, input: body.input.slice(previous.input.length) };
      } else {
        channel.continuation = undefined;
      }
      try {
        let first: Frame | undefined;
        let started = false;
        const prelude: Frame[] = [];
        let retried = false;
        for (;;) {
          if (request.signal.aborted) throw aborted();
          const sent = JSON.stringify({ type: "response.create", ...outgoing });
          // From here on a disconnect has an unknown execution outcome: never replay it.
          channel.socket.send(sent);
          exchange = { channel, body, completed: false, inputItems: outgoing.input.length,
            bodyBytes: Buffer.byteLength(sent), reused, persistent };
          for (;;) {
            first = await channel.next(request.signal, idleMs);
            if (first.type === "error") {
              if (!started && !retried && outgoing.previous_response_id && first.error?.code === "previous_response_not_found") {
                retried = true;
                channel.continuation = undefined;
                outgoing = body;
                prelude.length = 0;
                break;
              }
              throw errorFrame(first);
            }
            if (first.type?.startsWith("response.")) { started = true; break; }
            prelude.push(first);
            if (prelude.length > 64) throw new Error("CPA sent too many WebSocket prelude events");
          }
          if (started) break;
        }
        const current = exchange;
        const encoder = new TextEncoder();
        const queued = [...prelude, first!];
        const response = new ReadableStream<Uint8Array>({
          pull: async (controller) => {
            try {
              const frame = queued.shift() ?? await channel.next(request.signal, idleMs);
              if (frame.type === "error") throw errorFrame(frame);
              const terminal = frame.type === "response.completed" || frame.type === "response.incomplete" || frame.type === "response.failed";
              controller.enqueue(encoder.encode(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`));
              if (terminal) {
                current.completed = true;
                controller.close();
              }
            } catch (error) {
              channel.close();
              controller.error(error);
            }
          },
          cancel: () => channel.close(),
        });
        // This Response is a local WS-to-SSE bridge, not an upstream HTTP 200.
        return new Response(response, { headers: {
          "content-type": "text/event-stream",
          "x-reader-cpa-transport": "websocket",
          "x-reader-cpa-body-bytes": String(current.bodyBytes),
          "x-reader-cpa-full-body-bytes": String(Buffer.byteLength(text)),
          "x-reader-cpa-input-items": String(current.inputItems),
          "x-reader-cpa-connection-reused": String(reused),
          "x-reader-cpa-websocket-extensions": channel.socket.extensions,
          "x-reader-cpa-persistent": String(persistent),
        } });
      } catch (error) {
        channel.close();
        throw error;
      }
    };
    const stream = streamResponses(responseModel, context, { ...options, fetch });
    // Register before the caller awaits result(): the next tool/user turn must see
    // the completed, Pi-normalized output, never raw upstream replay items.
    void stream.result().then((message) => {
      const current = exchange;
      if (!current) return;
      const channel = current.channel;
      try {
        if (!current.completed || !message.responseId || !["stop", "toolUse", "length"].includes(message.stopReason)
          || options?.signal?.aborted || channel.failure) { channel.close(); return; }
        const grammar = createGrammarToolInputProperties(getDeclaredTools(context.messages), responseModel.compat?.supportsOpenAIGrammarTools ?? false);
        const reply = convertResponsesMessages(model, normalizeContext({ messages: [message] }), TOOL_CALL_PROVIDERS, {
          includeSystemPrompt: false, grammarToolInputProperties: grammar,
          ...(message.providerThinkingLevel === undefined ? {} : { configurationUpdateEffort: message.providerThinkingLevel }),
        }).filter((item) => item.type !== "function_call_output" && item.type !== "custom_tool_call_output");
        if (message.providerThinkingLevel !== undefined) {
          const update = current.body.input.at(-1) as { type?: string } | undefined;
          if (update?.type === "configuration_update") {
            // The sent request's final effort already introduces this reply.
            // The converter's final update belongs to the next request, not its prefix.
            if (reply.at(-1)?.type === "configuration_update" && hash(reply.at(-1)) === hash(update)) reply.pop();
            if (reply[0]?.type === "configuration_update" && hash(reply[0]) === hash(update)) reply.shift();
          }
        }
        channel.continuation = {
          parameters: parameters(current.body),
          input: [...current.body.input, ...reply].map(hash),
          responseId: message.responseId,
        };
        if (current.persistent) channel.release(this.sessionTtlMs);
        else channel.close();
      } catch { channel.close(); }
    }, () => exchange?.channel.close());
    return stream;
  }

  private async http(baseFetch: typeof globalThis.fetch, request: Request, text: string): Promise<Response> {
    const headers = new Headers(request.headers);
    const raw = Buffer.from(text);
    let bytes: Uint8Array = raw;
    if (raw.length >= COMPRESSION_THRESHOLD) {
      const compressed = await compress(raw, { params: { [constants.ZSTD_c_compressionLevel]: 3 } });
      if (compressed.length < raw.length) { bytes = compressed; headers.set("content-encoding", "zstd"); }
    }
    if (request.signal.aborted) throw aborted();
    headers.delete("content-length");
    let response = await baseFetch(new Request(request, { headers, body: new Uint8Array(bytes) }));
    if (headers.has("content-encoding") && response.status === 400
      && /unsupported request content encoding:\s*zstd/i.test(await response.clone().text())) {
      // This decoder rejection happens before model execution, so one plain replay is safe.
      if (request.signal.aborted) throw aborted();
      await response.body?.cancel();
      headers.delete("content-encoding");
      bytes = raw;
      response = await baseFetch(new Request(request, { headers, body: new Uint8Array(bytes) }));
    }
    const resultHeaders = new Headers(response.headers);
    resultHeaders.set("x-reader-cpa-transport", headers.has("content-encoding") ? "http-zstd" : "http");
    resultHeaders.set("x-reader-cpa-body-bytes", String(bytes.byteLength));
    resultHeaders.set("x-reader-cpa-full-body-bytes", String(raw.byteLength));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: resultHeaders });
  }

  private async acquire(endpoint: URL, headers: Headers, model: Model<Api>, options: SimpleStreamOptions | undefined, signal: AbortSignal) {
    if (signal.aborted) throw aborted();
    // Preserve configured proxy policy rather than silently bypassing it with ws.
    if (resolveHttpProxyUrlForTarget(endpoint, options?.env)) throw new Error("CPA WebSocket proxy transport is unavailable; using HTTP");
    const wsUrl = new URL(endpoint);
    wsUrl.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    const wsHeaders = new Headers(headers);
    for (const name of ["content-length", "content-type", "accept", "accept-encoding"]) wsHeaders.delete(name);
    wsHeaders.set("OpenAI-Beta", "responses_websockets=2026-02-06");
    const sessionId = options?.sessionId;
    const key = hash([sessionId, model.provider, model.id, wsUrl.href, [...wsHeaders].sort()]);
    const existing = sessionId ? this.channels.get(key) : undefined;
    if (existing && !existing.busy && !existing.failure && existing.socket.readyState === WebSocket.OPEN) {
      existing.acquire();
      return { channel: existing, reused: true, persistent: true };
    }
    // A concurrent request on the same logical session gets an isolated root,
    // rather than stealing an in-flight continuation or joining a global queue.
    let persistent = Boolean(sessionId && !existing?.busy);
    if (persistent && this.channels.size >= MAX_SESSIONS) {
      const idle = [...this.channels.values()].find((channel) => !channel.busy);
      if (idle) idle.close();
      else persistent = false;
    }
    let channel: Channel;
    const socket = this.createSocket(wsUrl.href, {
      headers: Object.fromEntries(wsHeaders), perMessageDeflate: true,
      handshakeTimeout: options?.websocketConnectTimeoutMs ?? 5_000,
    });
    channel = new Channel(sessionId, socket, () => {
      this.allChannels.delete(channel);
      if (this.channels.get(key) === channel) this.channels.delete(key);
    });
    this.allChannels.add(channel);
    if (persistent) this.channels.set(key, channel);
    try { await channel.open(signal); }
    catch (error) { channel.close(); throw error; }
    return { channel, reused: false, persistent };
  }
}

const defaultTransport = new CpaResponsesTransport();
const streamCpa = (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => defaultTransport.stream(model, context, options);

/** Keep models.json, native credentials and every unrelated provider unchanged. */
export function installCpaTransport(runtime: ModelRuntime): void {
  if (!runtime.getModels(PROVIDER).some((model) => model.api === "openai-responses")) return;
  // An explicitly registered user/provider implementation owns its transport.
  if (runtime.getRegisteredNativeProvider(PROVIDER) || runtime.getRegisteredProviderConfig(PROVIDER)?.streamSimple) return;
  runtime.registerProvider(PROVIDER, {
    api: "openai-responses",
    streamSimple: streamCpa,
  });
}
