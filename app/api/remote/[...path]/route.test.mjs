import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({
  device: { id: "mini", name: "Mac Mini", url: "http://mini.local:30141" },
  peers: [
    { id: "debian", name: "Debian", url: "http://debian.local:30141" },
    { id: "air", name: "MacBook Air", url: "http://air.local:30141" },
    { id: "air-preview", name: "MacBook Air preview", url: "https://air.local:30143" },
  ],
});

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET, POST, PUT, DELETE } = await jiti.import("./route.ts");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(impl) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = ((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return Promise.resolve(impl(url, init));
  })
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

test("GET without peer returns 400", async () => {
  const res = await GET(new Request("http://x/api/remote/sessions/abc"), { params: Promise.resolve({ path: ["sessions", "abc"] }) });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /Missing peer/);
});

test("GET unknown peer returns 404", async () => {
  const mock = mockFetch(() => jsonResponse({}));
  try {
    const res = await GET(new Request("http://x/api/remote/sessions/abc?peer=ghost"), { params: Promise.resolve({ path: ["sessions", "abc"] }) });
    assert.equal(res.status, 404);
    assert.match(await res.text(), /Unknown peer/);
  } finally {
    mock.restore();
  }
});

test("GET forwards to peer base URL and passes through JSON", async () => {
  const mock = mockFetch(() => jsonResponse({ hello: "world" }));
  try {
    const res = await GET(new Request("http://x/api/remote/sessions/abc?peer=debian&deferThinking=1"), {
      params: Promise.resolve({ path: ["sessions", "abc"] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { hello: "world" });
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].url, "http://debian.local:30141/api/sessions/abc?deferThinking=1");
  } finally {
    mock.restore();
  }
});

test("preview channel forwards configured production peer URLs to preview HTTPS", async () => {
  const mock = mockFetch(() => jsonResponse({ ok: true }));
  try {
    const res = await GET(new Request("http://mini.local:30142/api/remote/image-gen?peer=air-preview&quote=1", {
      headers: { host: "mini.local:30142", "x-forwarded-host": "mini.local:30144" },
    }), {
      params: Promise.resolve({ path: ["image-gen"] }),
    });
    assert.equal(res.status, 200);
    assert.equal(mock.calls[0].url, "https://air.local:30144/api/image-gen?quote=1");
  } finally {
    mock.restore();
  }
});

test("remote proxy turns upstream timeout into structured JSON", async () => {
  const mock = mockFetch(() => Promise.reject(new DOMException("timed out", "TimeoutError")));
  try {
    const res = await PUT(new Request("http://x/api/remote/models-config?peer=debian", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providers: {} }),
    }), { params: Promise.resolve({ path: ["models-config"] }) });
    assert.equal(res.status, 504);
    assert.deepEqual(await res.json(), { error: "Remote request timed out", code: "remote_timeout" });
  } finally {
    mock.restore();
  }
});

test("remote proxy turns peer connection failures into structured JSON", async () => {
  const mock = mockFetch(() => Promise.reject(new Error("fetch failed")));
  try {
    const res = await GET(new Request("http://x/api/remote/models?peer=debian"), {
      params: Promise.resolve({ path: ["models"] }),
    });
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: "Remote peer request failed", code: "remote_unavailable" });
  } finally {
    mock.restore();
  }
});

test("model config relay requests receive time for their 20 second upstream budget", async () => {
  const originalTimeout = AbortSignal.timeout;
  const observedTimeouts = [];
  AbortSignal.timeout = (milliseconds) => {
    observedTimeouts.push(milliseconds);
    return new AbortController().signal;
  };
  const mock = mockFetch(() => jsonResponse({ ok: true }));
  try {
    await POST(new Request("http://x/api/remote/models-config/test?peer=debian", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }), { params: Promise.resolve({ path: ["models-config", "test"] }) });
    assert.deepEqual(observedTimeouts, [30_000]);
  } finally {
    AbortSignal.timeout = originalTimeout;
    mock.restore();
  }
});

test("GET forwards Range and preserves 206 file metadata without a short timeout", async () => {
  let captured = {};
  const mock = mockFetch((url, init) => {
    captured = { url, init };
    return new Response("0123456789", {
      status: 206,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": "10",
        "content-range": "bytes 0-9/100",
        "accept-ranges": "bytes",
      },
    });
  });
  try {
    const request = new Request("http://x/api/remote/files/video.mp4?peer=debian&type=download", {
      headers: { Range: "bytes=0-9", "If-Range": "etag-1" },
    });
    const res = await GET(request, {
      params: Promise.resolve({ path: ["files", "video.mp4"] }),
    });
    assert.equal(res.status, 206);
    assert.equal(captured.init && captured.init.signal, request.signal);
    assert.equal(captured.init && captured.init.headers.get("range"), "bytes=0-9");
    assert.equal(captured.init && captured.init.headers.get("if-range"), "etag-1");
    assert.equal(res.headers.get("content-length"), "10");
    assert.equal(res.headers.get("content-range"), "bytes 0-9/100");
    assert.equal(res.headers.get("accept-ranges"), "bytes");
    assert.equal(await res.text(), "0123456789");
  } finally {
    mock.restore();
  }
});

test("remote file watch propagates downstream abort and body cancellation", async () => {
  let signal;
  let cancellations = 0;
  const mock = mockFetch((_url, init) => {
    signal = init.signal;
    return new Response(new ReadableStream({ cancel() { cancellations += 1; } }), {
      headers: { "content-type": "text/event-stream" },
    });
  });
  try {
    const abort = new AbortController();
    const request = new Request("http://x/api/remote/files/file.txt?peer=debian&type=watch", {
      headers: { accept: "text/event-stream" }, signal: abort.signal,
    });
    const res = await GET(request, { params: Promise.resolve({ path: ["files", "file.txt"] }) });
    assert.equal(signal, request.signal);
    abort.abort();
    assert.equal(signal.aborted, true);
    await res.body.cancel();
    assert.equal(cancellations, 1);
  } finally {
    mock.restore();
  }
});

test("cross-origin PDF navigation cannot relay session-reference authority", async () => {
  const mock = mockFetch(() => new Response("pdf", { status: 206, headers: {
    "content-type": "application/pdf", "content-range": "bytes 0-2/3", "x-content-type-options": "nosniff",
  } }));
  try {
    const headers = { host: "localhost", "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-user": "?1", range: "bytes=0-2" };
    const url = "http://localhost/api/remote/files/docs/report.pdf?peer=debian&type=read&sessionId=outside-session&v=1";
    const params = { params: Promise.resolve({ path: ["files", "docs", "report.pdf"] }) };
    const response = await GET(new Request(url, { headers }), params);
    assert.equal(response.status, 206);
    assert.equal(mock.calls[0].url, "http://debian.local:30141/api/files/docs/report.pdf?type=read&v=1");
    assert.equal(mock.calls[0].init.headers.get("range"), "bytes=0-2");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("content-range"), "bytes 0-2/3");
    await GET(new Request(url, { headers: { ...headers, "sec-fetch-site": "same-origin" } }), params);
    assert.match(mock.calls[1].url, /sessionId=outside-session/);
  } finally {
    mock.restore();
  }
});

test("GET preserves peer response security headers for remote content", async () => {
  const mock = mockFetch(() => new Response("<svg></svg>", {
    headers: {
      "content-type": "image/svg+xml",
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  }));
  try {
    const res = await GET(new Request("http://x/api/remote/files/tmp.svg?peer=debian&type=download"), {
      params: Promise.resolve({ path: ["files", "tmp.svg"] }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-security-policy"), "default-src 'none'");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  } finally {
    mock.restore();
  }
});

test("GET forwards HTML preview resources with peer identity in the path", async () => {
  const mock = mockFetch(() => new Response("console.log('ok')", {
    headers: { "content-type": "text/javascript; charset=utf-8" },
  }));
  try {
    const res = await GET(new Request("http://x/api/remote/html-preview/debian/session-1/repo/assets/d3.js"), {
      params: Promise.resolve({ path: ["html-preview", "debian", "session-1", "repo", "assets", "d3.js"] }),
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "console.log('ok')");
    assert.equal(mock.calls[0].url, "http://debian.local:30141/api/html-preview/session-1/repo/assets/d3.js");
  } finally {
    mock.restore();
  }
});

test("GET resolves the local device url when peer is self", async () => {
  const mock = mockFetch(() => jsonResponse({}));
  try {
    await GET(new Request("http://x/api/remote/sessions/abc?peer=mini"), { params: Promise.resolve({ path: ["sessions", "abc"] }) });
    assert.equal(mock.calls[0].url, "http://mini.local:30141/api/sessions/abc");
  } finally {
    mock.restore();
  }
});

test("POST preserves multipart content type for remote file uploads", async () => {
  let captured = {};
  const mock = mockFetch((url, init) => {
    captured = { url, init };
    return jsonResponse({ ok: true });
  });
  try {
    const body = new FormData();
    body.append("files", new Blob(["hello"], { type: "text/plain" }), "hello.txt");
    const request = new Request("http://x/api/remote/files/tmp?peer=debian&type=upload", { method: "POST", body });
    const res = await POST(request, { params: Promise.resolve({ path: ["files", "tmp"] }) });
    assert.equal(res.status, 200);
    assert.equal(captured.init && captured.init.headers.get("content-type"), request.headers.get("content-type"));
    assert.match(captured.init && captured.init.headers.get("content-type"), /multipart\/form-data; boundary=/);
  } finally {
    mock.restore();
  }
});

test("POST forwards method and body", async () => {
  let captured = {};
  const mock = mockFetch((url, init) => {
    captured = { url, init };
    return jsonResponse({ ok: true });
  });
  try {
    const body = JSON.stringify({ prompt: "continue" });
    const res = await POST(new Request("http://x/api/remote/agent/abc?peer=debian", { method: "POST", body }), {
      params: Promise.resolve({ path: ["agent", "abc"] }),
    });
    assert.equal(res.status, 200);
    assert.equal(captured.url, "http://debian.local:30141/api/agent/abc");
    assert.equal(captured.init && captured.init.method, "POST");
    const sent = await new Response(captured.init && captured.init.body).text();
    assert.deepEqual(JSON.parse(sent), { prompt: "continue" });
  } finally {
    mock.restore();
  }
});

test("POST forwards Quick Ask image payload unchanged", async () => {
  let captured = {};
  const mock = mockFetch((url, init) => {
    captured = { url, init };
    return jsonResponse({ ok: true });
  });
  try {
    const body = JSON.stringify({
      question: "inspect this",
      images: [{ data: "AAAA", mimeType: "image/png" }],
    });
    const res = await POST(new Request("http://x/api/remote/sessions/abc/quick-ask?peer=debian", { method: "POST", body }), {
      params: Promise.resolve({ path: ["sessions", "abc", "quick-ask"] }),
    });
    assert.equal(res.status, 200);
    assert.equal(captured.url, "http://debian.local:30141/api/sessions/abc/quick-ask");
    const sent = await new Response(captured.init && captured.init.body).text();
    assert.deepEqual(JSON.parse(sent), JSON.parse(body));
  } finally {
    mock.restore();
  }
});

test("PUT forwards method and body", async () => {
  let captured = {};
  const mock = mockFetch((url, init) => {
    captured = { url, init };
    return jsonResponse({ ok: true });
  });
  try {
    const body = JSON.stringify({ providers: { custom: { models: [{ id: "model" }] } } });
    const res = await PUT(new Request("http://x/api/remote/models-config?peer=debian", { method: "PUT", body }), {
      params: Promise.resolve({ path: ["models-config"] }),
    });
    assert.equal(res.status, 200);
    assert.equal(captured.url, "http://debian.local:30141/api/models-config");
    assert.equal(captured.init && captured.init.method, "PUT");
    const sent = await new Response(captured.init && captured.init.body).text();
    assert.deepEqual(JSON.parse(sent), { providers: { custom: { models: [{ id: "model" }] } } });
  } finally {
    mock.restore();
  }
});

test("DELETE forwards method and body", async () => {
  let captured = {};
  const mock = mockFetch((url, init) => {
    captured = { url, init };
    return jsonResponse({ ok: true });
  });
  try {
    const body = JSON.stringify({ id: "subproject-1" });
    const res = await DELETE(new Request("http://x/api/remote/subprojects?peer=debian", { method: "DELETE", body }), {
      params: Promise.resolve({ path: ["subprojects"] }),
    });
    assert.equal(res.status, 200);
    assert.equal(captured.url, "http://debian.local:30141/api/subprojects");
    assert.equal(captured.init && captured.init.method, "DELETE");
    const sent = await new Response(captured.init && captured.init.body).text();
    assert.deepEqual(JSON.parse(sent), { id: "subproject-1" });
  } finally {
    mock.restore();
  }
});

test("GET forwards SSE stream with content-type", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("data: {\"hello\":\"world\"}\n\n"));
      controller.close();
    },
  });
  const mock = mockFetch(() => new Response(stream, { headers: { "content-type": "text/event-stream" } }));
  try {
    const res = await GET(new Request("http://x/api/remote/agent/abc/events?peer=air"), {
      params: Promise.resolve({ path: ["agent", "abc", "events"] }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const body = await res.text();
    assert.match(body, /data: \{/);
  } finally {
    mock.restore();
  }
});


test("GET forwards stream diagnostics through the peer path without dropping its query contract", async () => {
  let captured = "";
  const mock = mockFetch((url) => {
    captured = url;
    return jsonResponse({ schemaVersion: 1, coverage: { readOnly: true }, streams: [] });
  });
  try {
    const res = await GET(new Request("http://x/api/remote/reader/stream-diagnostics?peer=air", {
      headers: { accept: "application/json" },
    }), { params: Promise.resolve({ path: ["reader", "stream-diagnostics"] }) });
    assert.equal(res.status, 200);
    assert.equal(captured, "http://air.local:30141/api/reader/stream-diagnostics");
  } finally {
    mock.restore();
  }
});


test("terminal lifecycle routes preserve the configured peer", async () => {
  const id = "a".repeat(32);
  const mock = mockFetch(() => jsonResponse({ ok: true }));
  try {
    await POST(new Request(`http://x/api/remote/terminal?peer=debian`, { method: "POST", body: JSON.stringify({ id, cwd: "/repo", cols: 80, rows: 24 }) }), { params: Promise.resolve({ path: ["terminal"] }) });
    await GET(new Request(`http://x/api/remote/terminal/${id}?peer=debian`), { params: Promise.resolve({ path: ["terminal", id] }) });
    await POST(new Request(`http://x/api/remote/terminal/${id}?peer=debian`, { method: "POST", body: JSON.stringify({ type: "input", data: "pwd\r" }) }), { params: Promise.resolve({ path: ["terminal", id] }) });
    await POST(new Request(`http://x/api/remote/terminal/${id}?peer=debian`, { method: "POST", body: JSON.stringify({ type: "resize", cols: 100, rows: 30 }) }), { params: Promise.resolve({ path: ["terminal", id] }) });
    await GET(new Request(`http://x/api/remote/terminal/${id}/events?peer=debian`, { headers: { accept: "text/event-stream" } }), { params: Promise.resolve({ path: ["terminal", id, "events"] }) });
    await DELETE(new Request(`http://x/api/remote/terminal/${id}?peer=debian`, { method: "DELETE" }), { params: Promise.resolve({ path: ["terminal", id] }) });
    assert.deepEqual(mock.calls.map((call) => call.url), [
      `http://debian.local:30141/api/terminal`,
      `http://debian.local:30141/api/terminal/${id}`,
      `http://debian.local:30141/api/terminal/${id}`,
      `http://debian.local:30141/api/terminal/${id}`,
      `http://debian.local:30141/api/terminal/${id}/events`,
      `http://debian.local:30141/api/terminal/${id}`,
    ]);
  } finally {
    mock.restore();
  }
});


test("POST forwards remote file create payload and peer identity", async () => {
  let captured = {};
  const mock = mockFetch((url, init) => {
    captured = { url, init };
    return jsonResponse({ created: true, path: "/repo/docs/README.md", isDir: false });
  });
  try {
    const body = JSON.stringify({ name: "README.md" });
    const res = await POST(new Request("http://x/api/remote/files/repo/docs?peer=debian&type=create-file", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }), { params: Promise.resolve({ path: ["files", "repo", "docs"] }) });
    assert.equal(res.status, 200);
    assert.equal(captured.url, "http://debian.local:30141/api/files/repo/docs?type=create-file");
    assert.equal(captured.init && captured.init.method, "POST");
    assert.deepEqual(JSON.parse(await new Response(captured.init && captured.init.body).text()), { name: "README.md" });
  } finally {
    mock.restore();
  }
});
