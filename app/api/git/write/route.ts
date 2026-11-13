import fs from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { isWindowsAbsolutePath } from "@/lib/paths";
import { GitWriteError, runGitWrite, withGitWriteLock, type GitWriteAction } from "@/lib/git-write";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = 64 * 1024;

function parseAction(value: unknown): GitWriteAction | null {
  return value === "stage" || value === "commit" || value === "push" || value === "create-branch" ? value : null;
}

export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: "Git write request is too large" }, { status: 413 });
  }

  try {
    const body = await request.json() as {
      cwd?: unknown;
      action?: unknown;
      paths?: unknown;
      message?: unknown;
      branchName?: unknown;
    };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    const action = parseAction(body.action);
    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
    }
    if (!action) return NextResponse.json({ error: "Unsupported Git write action" }, { status: 400 });

    let stat: fs.Stats;
    try {
      stat = fs.statSync(cwd);
    } catch {
      return NextResponse.json({ error: "Directory not found" }, { status: 404 });
    }
    if (!stat.isDirectory()) return NextResponse.json({ error: "Not a directory" }, { status: 400 });

    const result = await withGitWriteLock(() => runGitWrite(cwd, action, {
      paths: Array.isArray(body.paths) ? body.paths as string[] : undefined,
      message: body.message,
      branchName: body.branchName,
    }));
    return NextResponse.json({ ok: true, result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof GitWriteError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: "Git write operation failed" }, { status: 500 });
  }
}
