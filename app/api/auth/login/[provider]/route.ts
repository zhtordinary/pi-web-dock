import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { invalidateModelsCache } from "@/lib/models-cache";
import { createLoginOptions, createModelRuntimeWithExtensions, disposeModelRuntime } from "@/lib/model-runtime";
import {
  registerReaderStreamCloser,
  READER_STREAM_HIGH_WATER_MARK_BYTES,
  type ReaderStreamDiagnostic,
} from "@/lib/reader-event-stream";

export const dynamic = "force-dynamic";

// In-memory registry: loginToken -> resolve/reject for the manualCodeInput promise
declare global {
  var __piLoginCallbacks: Map<string, { resolve: (v: string) => void; reject: (e: Error) => void }> | undefined;
}

function getCallbackRegistry() {
  if (!globalThis.__piLoginCallbacks) globalThis.__piLoginCallbacks = new Map();
  return globalThis.__piLoginCallbacks;
}

// POST /api/auth/login/[provider] — frontend sends redirect URL or auth code
export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  const { token, code } = (await req.json()) as { token?: string; code?: string };

  if (!token || !code) {
    return Response.json({ error: "token and code required" }, { status: 400 });
  }

  const registry = getCallbackRegistry();
  const callbacks = registry.get(token);
  if (!callbacks) {
    return Response.json({ error: "No pending login for token" }, { status: 404 });
  }
  // Verify token belongs to this provider (token format: "<provider>-<uuid>")
  if (!token.startsWith(`${provider}-`)) {
    return Response.json({ error: "Token does not match provider" }, { status: 400 });
  }

  callbacks.resolve(code);
  registry.delete(token);
  return Response.json({ ok: true, provider });
}

// GET /api/auth/login/[provider] — SSE stream for OAuth flow
export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  const encoder = new TextEncoder();

  // AbortController propagates client disconnect into ModelRuntime.login().
  const abort = new AbortController();
  const abortRequest = () => abort.abort();
  req.signal.addEventListener("abort", abortRequest, { once: true });

  const stream = new ReadableStream({
    async start(controller) {
      const diagnostic: ReaderStreamDiagnostic = {
        kind: "provider-login",
        sessionId: null,
        holder: null,
        openedAt: Date.now(),
        connectedAt: null,
        lastWriteAt: null,
        droppedEvents: 0,
        queuedBytes: 0,
      };
      let closed = false;
      let unregister = () => {};
      const registry = getCallbackRegistry();
      const activeTokens = new Set<string>();
      let pendingManualRequest: { token: string; promise: Promise<string> } | undefined;

      const cleanupPending = () => {
        for (const token of activeTokens) {
          registry.get(token)?.reject(new Error("Login cancelled"));
          registry.delete(token);
        }
        activeTokens.clear();
      };
      const cleanup = (mode: boolean | "error" = true) => {
        if (closed) return;
        closed = true;
        cleanupPending();
        abort.abort();
        req.signal.removeEventListener("abort", abortRequest);
        abort.signal.removeEventListener("abort", cleanupPending);
        try {
          if (mode === "error") controller.error(new Error("Reader provider login stream shutting down"));
          else if (mode) controller.close();
        } catch { /* stream already closed */ }
        finally { unregister(); }
      };
      const send = (data: unknown) => {
        if (closed) return false;
        if ((controller.desiredSize ?? 0) <= 0) {
          diagnostic.droppedEvents += 1;
          cleanup("error");
          return false;
        }
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          const now = Date.now();
          diagnostic.connectedAt ??= now;
          diagnostic.lastWriteAt = now;
          diagnostic.queuedBytes = Math.max(0, READER_STREAM_HIGH_WATER_MARK_BYTES - (controller.desiredSize ?? READER_STREAM_HIGH_WATER_MARK_BYTES));
          return true;
        } catch {
          cleanup(false);
          return false;
        }
      };
      abort.signal.addEventListener("abort", cleanupPending);
      unregister = registerReaderStreamCloser(cleanup, diagnostic);
      let loginOptions: ReturnType<typeof createLoginOptions> | undefined;
      let modelRuntime: Awaited<ReturnType<typeof createModelRuntimeWithExtensions>> | undefined;

      try {
        modelRuntime = await createModelRuntimeWithExtensions();
        if (!modelRuntime.getProvider(provider)?.auth.oauth) {
          send({ type: "error", message: `Unknown provider: ${provider}` });
          cleanup();
          return;
        }

        loginOptions = createLoginOptions();
        const createClientInputRequest = () => {
          // Manual-code handshake token; crypto randomness so a pending OAuth
          // manual flow cannot be hijacked by predicting Math.random().
          const token = `${provider}-${randomUUID()}`;
          activeTokens.add(token);

          const promise = new Promise<string>((resolve, reject) => {
            registry.set(token, {
              resolve: (value) => {
                activeTokens.delete(token);
                registry.delete(token);
                resolve(value);
              },
              reject: (error) => {
                activeTokens.delete(token);
                registry.delete(token);
                reject(error);
              },
            });
          });

          return { token, promise };
        };

        const getManualInputRequest = () => {
          if (!pendingManualRequest) {
            pendingManualRequest = createClientInputRequest();
            pendingManualRequest.promise
              .finally(() => {
                pendingManualRequest = undefined;
              })
              .catch(() => {});
          }
          return pendingManualRequest;
        };

        await modelRuntime.login(provider, "oauth", {
          prompt: async (prompt: AuthPrompt) => {
            const request = prompt.type === "manual_code"
              ? getManualInputRequest()
              : createClientInputRequest();
            if (prompt.type === "select") {
              send({
                type: "select_request",
                message: prompt.message,
                options: prompt.options,
                token: request.token,
              });
            } else {
              send({
                type: "prompt_request",
                message: prompt.message,
                placeholder: prompt.placeholder ?? null,
                token: request.token,
              });
            }
            return request.promise;
          },
          notify: (event: AuthEvent) => {
            if (event.type === "auth_url") {
              const request = getManualInputRequest();
              send({
                type: "auth",
                url: event.url,
                instructions: event.instructions ?? null,
                token: request.token,
              });
            } else if (event.type === "device_code") {
              send({
                type: "device_code",
                userCode: event.userCode,
                verificationUri: event.verificationUri,
                intervalSeconds: event.intervalSeconds ?? null,
                expiresInSeconds: event.expiresInSeconds ?? null,
              });
            } else {
              send({ type: "progress", message: event.message });
            }
          },
          signal: abort.signal,
        }, loginOptions.options);

        invalidateModelsCache();
        send({ type: "success" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg !== "Login cancelled") {
          send({ type: "error", message: msg });
        } else {
          send({ type: "cancelled" });
        }
      } finally {
        cleanup();
        if (modelRuntime) disposeModelRuntime(modelRuntime);
        await loginOptions?.flush();
      }
    },
    cancel() {
      abort.abort();
    },
  }, {
    highWaterMark: READER_STREAM_HIGH_WATER_MARK_BYTES,
    size: (chunk) => chunk.byteLength,
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
