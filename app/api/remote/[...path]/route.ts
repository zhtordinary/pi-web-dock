import { NextResponse } from "next/server";
import { resolvePeerUrlForRequest } from "@/lib/activity-peers";
import { isCrossOriginPdfNavigation } from "@/lib/request-security";

// 跨设备 API 代理：把本机请求转发到已配置 peer 的 /api/<path>。
// 请求不转发浏览器凭据，SSE 响应通过 ReadableStream 透传。

export const dynamic = "force-dynamic";

const MODEL_CONFIG_LONG_TIMEOUT_MS = 30_000;
const MODEL_CONFIG_LONG_PATHS = new Set(["catalog", "discover", "discover-managed", "test"]);

function isLongModelConfigRequest(path: readonly string[]): boolean {
  return path[0] === "models-config" && MODEL_CONFIG_LONG_PATHS.has(path[1] ?? "");
}

async function forward(req: Request, path: string[], peerId: string, method: string) {
  const baseUrl = resolvePeerUrlForRequest(peerId, req.url, req.headers);
  if (!baseUrl) {
    return NextResponse.json({ error: `Unknown peer: ${peerId}` }, { status: 404 });
  }

  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return NextResponse.json({ error: "Invalid request URL" }, { status: 400 });
  }
  url.searchParams.delete("peer");
  // A navigation exception must not carry a session-specific reference to the peer.
  if (isCrossOriginPdfNavigation(req)) url.searchParams.delete("sessionId");
  const target = `${baseUrl.replace(/\/$/, "")}/api/${path.map(encodeURIComponent).join("/")}${url.search}`;

  const isSse = req.headers.get("accept")?.includes("text/event-stream") || path.at(-1) === "events";
  const isFileTransfer = path[0] === "files" || path[0] === "html-preview" || path.at(-1) === "image" || path.at(-1) === "tool-result-image";
  // MCP test probes are the one ordinary JSON call allowed a longer upstream
  // deadline. Model discovery and model tests have their own 20 second upstream
  // budget, so leave enough relay time for them to finish and serialize JSON.
  const isMcpTest = method === "POST" && path.length === 2 && path[0] === "mcp" && path[1] === "test";
  const isSessionClose = method === "POST" && path.length === 3 && path[0] === "sessions"
    && ["stop", "shutdown", "archive"].includes(path[2]);
  // File/media transfers can legitimately exceed the short API timeout. Let
  // the streaming body drain; ordinary JSON APIs retain a bounded timeout.
  const signal = isSse || isFileTransfer
    ? method === "GET" ? req.signal : undefined
    : isSessionClose
      ? AbortSignal.timeout(40_000)
      : isLongModelConfigRequest(path)
      ? AbortSignal.timeout(MODEL_CONFIG_LONG_TIMEOUT_MS)
      : AbortSignal.timeout(isMcpTest ? 65_000 : 12_000);
  const targetHeaders = new Headers({
    accept: req.headers.get("accept") ?? "application/json",
  });
  const requestContentType = req.headers.get("content-type");
  if (requestContentType) targetHeaders.set("content-type", requestContentType);
  for (const header of ["range", "if-range"]) {
    const value = req.headers.get(header);
    if (value) targetHeaders.set(header, value);
  }
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers: targetHeaders,
      // JSON body 原样透传。Node fetch 对流式 body 必须显式 duplex: "half"。
      ...(method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE" ? { body: req.body as ReadableStream | null, duplex: "half" as const } : {}),
      cache: "no-store",
      ...(signal ? { signal } : {}),
      // SSE 长连接不设超时。
    });
  } catch (error) {
    const timedOut = ((!isSse && !isFileTransfer) && signal?.aborted === true) || (error instanceof Error && error.name === "TimeoutError");
    return NextResponse.json({
      error: timedOut ? "Remote request timed out" : "Remote peer request failed",
      code: timedOut ? "remote_timeout" : "remote_unavailable",
    }, {
      status: timedOut ? 504 : 502,
      headers: { "cache-control": "no-store" },
    });
  }

  const responseHeaders = new Headers();
  responseHeaders.set("content-type", upstream.headers.get("content-type") ?? "application/json");
  responseHeaders.set("cache-control", "no-store");
  // Preserve the peer's response hardening for file and HTML-preview routes.
  // Dropping these headers would turn authenticated remote SVG/HTML responses
  // into script-capable content in the Pi Web origin.
  for (const header of [
    "content-security-policy",
    "x-content-type-options",
    "referrer-policy",
    "content-length",
    "content-range",
    "accept-ranges",
  ]) {
    const value = upstream.headers.get(header);
    if (value) responseHeaders.set(header, value);
  }
  const accelBuffering = upstream.headers.get("x-accel-buffering");
  if (accelBuffering) {
    responseHeaders.set("x-accel-buffering", accelBuffering);
  }
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

function parsePeerIdFromRequest(req: Request): string | null {
  try {
    return new URL(req.url).searchParams.get("peer");
  } catch {
    return null;
  }
}

export async function GET(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  // HTML preview keeps peer identity in the path because srcDoc relative
  // resources drop query parameters while resolving their base URL.
  if (path[0] === "html-preview") {
    if (path.length < 3) {
      return NextResponse.json({ error: "Invalid HTML preview resource path" }, { status: 400 });
    }
    return forward(req, ["html-preview", ...path.slice(2)], decodeURIComponent(path[1]), "GET");
  }
  const peerId = parsePeerIdFromRequest(req);
  if (!peerId) {
    return NextResponse.json({ error: "Missing peer query parameter" }, { status: 400 });
  }
  return forward(req, path, peerId, "GET");
}

export async function POST(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const peerId = parsePeerIdFromRequest(req);
  if (!peerId) {
    return NextResponse.json({ error: "Missing peer query parameter" }, { status: 400 });
  }
  return forward(req, path, peerId, "POST");
}

export async function PUT(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const peerId = parsePeerIdFromRequest(req);
  if (!peerId) {
    return NextResponse.json({ error: "Missing peer query parameter" }, { status: 400 });
  }
  return forward(req, path, peerId, "PUT");
}

export async function DELETE(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const peerId = parsePeerIdFromRequest(req);
  if (!peerId) {
    return NextResponse.json({ error: "Missing peer query parameter" }, { status: 400 });
  }
  return forward(req, path, peerId, "DELETE");
}

export async function PATCH(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const peerId = parsePeerIdFromRequest(req);
  if (!peerId) {
    return NextResponse.json({ error: "Missing peer query parameter" }, { status: 400 });
  }
  return forward(req, path, peerId, "PATCH");
}
