import { homedir } from "os";
import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { isWindowsAbsolutePath, toSlashPath as normalizeSlashes } from "@/lib/paths";
import { getImageMime, getFileExt } from "@/lib/file-types";

const MAX_RESOURCE_BYTES = 10 * 1024 * 1024;

const TEXT_RESOURCE_MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  cjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  wasm: "application/wasm",
  txt: "text/plain; charset=utf-8",
};

const FONT_RESOURCE_MIME: Record<string, string> = {
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
};

function filePathFromSegments(segments: string[]): string {
  const joined = segments.join("/");
  if (joined.startsWith("~")) {
    return path.join(homedir(), joined.slice(1).replace(/^[/\\]+/, ""));
  }
  const slashJoined = normalizeSlashes(joined);
  if (isWindowsAbsolutePath(slashJoined)) return slashJoined;
  return "/" + joined.replace(/^\/+/, "");
}

function resourceMime(filePath: string): string | null {
  return getImageMime(filePath)
    || TEXT_RESOURCE_MIME[getFileExt(filePath)]
    || FONT_RESOURCE_MIME[getFileExt(filePath)]
    || null;
}

function createFileBodyStream(filePath: string): ReadableStream<Uint8Array> {
  const fileStream = fs.createReadStream(filePath);
  let closed = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      fileStream.on("data", (chunk: Buffer) => {
        if (closed) return;
        try {
          controller.enqueue(new Uint8Array(chunk));
        } catch {
          closed = true;
          fileStream.destroy();
        }
      });
      fileStream.once("end", () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // The browser may cancel a subresource before it finishes.
        }
      });
      fileStream.once("error", (error) => {
        if (closed) return;
        closed = true;
        try {
          controller.error(error);
        } catch {
          // The response was already abandoned by the client.
        }
      });
    },
    cancel() {
      closed = true;
      fileStream.destroy();
    },
  });
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  try {
    const { path: segments } = await params;
    if (segments.length < 2) {
      return NextResponse.json({ error: "Invalid HTML preview resource path" }, { status: 400 });
    }

    const [, ...fileSegments] = segments;
    const filePath = filePathFromSegments(fileSegments);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (!stat.isFile()) {
      return NextResponse.json({ error: "Not a file" }, { status: 400 });
    }
    const contentType = resourceMime(filePath);
    if (!contentType) {
      return NextResponse.json({ error: "Preview resource type not supported" }, { status: 415 });
    }
    if (stat.size > MAX_RESOURCE_BYTES) {
      return NextResponse.json({ error: "Preview resource too large (>10MB)" }, { status: 413 });
    }

    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Content-Length": String(stat.size),
      "Cache-Control": "no-cache",
      "Content-Disposition": "inline",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    };
    if (contentType === "text/html; charset=utf-8") {
      // A card opened from the sandboxed graph must stay sandboxed too.
      headers["Content-Security-Policy"] = "sandbox allow-scripts allow-popups; frame-ancestors 'self'";
    } else if (contentType === "image/svg+xml") {
      headers["Content-Security-Policy"] = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
    }

    return new Response(createFileBodyStream(filePath), { headers });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
