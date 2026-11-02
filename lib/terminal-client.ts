function appendPeer(path: string, peer?: string): string {
  if (!peer) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `/api/remote${path.startsWith("/api") ? path.slice(4) : path}${separator}peer=${encodeURIComponent(peer)}`;
}

export function terminalApiPath(path: string, peer?: string): string {
  return appendPeer(path, peer);
}

export function terminalEventPath(id: string, peer?: string, after?: number): string {
  const path = `/api/terminal/${encodeURIComponent(id)}/events${after === undefined ? "" : `?after=${after}`}`;
  return appendPeer(path, peer);
}

export async function terminalRequest(path: string, options?: RequestInit, peer?: string): Promise<{ id?: string; cwd?: string }> {
  const timeout = AbortSignal.timeout(15_000);
  const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(appendPeer(path, peer), { ...options, signal });
  } catch (error) {
    if (timeout.aborted) throw new Error("Terminal request timed out. Reconnect to check its state; input was not replayed.");
    throw error;
  }
  const data = await response.json().catch(() => {
    throw new Error(`Terminal request failed (HTTP ${response.status}): server returned an empty or invalid JSON response. Check the pi-web server log.`);
  });
  if (!data || typeof data !== "object") throw new Error(`Terminal request failed (HTTP ${response.status}): invalid JSON response. Check the pi-web server log.`);
  if (!response.ok) throw Object.assign(new Error(data.error ?? `HTTP ${response.status}`), { status: response.status });
  return data;
}

export function createTerminalWriter(id: string, onError: (error: Error) => void, peer?: string) {
  let pending = Promise.resolve();
  const controller = new AbortController();
  let stopped = false;
  let bufferedInput: { type: "input"; data: string } | null = null;
  const enqueue = (body: Record<string, unknown>) => {
    if (stopped) return;
    pending = pending.then(async () => {
      if (stopped) return;
      if (body === bufferedInput) bufferedInput = null;
      await terminalRequest(`/api/terminal/${encodeURIComponent(id)}`, {
        signal: controller.signal,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, peer);
    }).catch((error: Error) => {
      // Delivery is ambiguous after a network error. Never replay shell input.
      if (!stopped) { stopped = true; onError(error); }
    });
  };
  return {
    write(data: string) {
      if (stopped) return;
      for (const chunk of data.match(/[\s\S]{1,32768}/gu) ?? []) {
        if (bufferedInput && bufferedInput.data.length + chunk.length <= 65536) bufferedInput.data += chunk;
        else {
          bufferedInput = { type: "input", data: chunk };
          enqueue(bufferedInput);
        }
      }
    },
    resize(cols: number, rows: number) {
      bufferedInput = null;
      enqueue({ type: "resize", cols, rows });
    },
    stop() { stopped = true; bufferedInput = null; controller.abort(); return pending; },
  };
}

export async function closeTerminal(id: string, start: Promise<void>, writer: ReturnType<typeof createTerminalWriter> | null, peer?: string): Promise<void> {
  await start.catch(() => { /* Creation failure still permits cleanup. */ });
  await writer?.stop();
  try {
    await terminalRequest(`/api/terminal/${encodeURIComponent(id)}`, { method: "DELETE", keepalive: true }, peer);
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
  }
}
