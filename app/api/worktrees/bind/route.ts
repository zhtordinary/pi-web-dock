import { existsSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { NextResponse } from "next/server";
import { appendWorktreeBinding, type WorktreeBindingRelation } from "@/lib/worktree-bindings";
import { acquireSessionRuntimeOwnership } from "@/lib/session-runtime-ownership";
import { emitActivityEvent } from "@/lib/activity-events";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getRpcSession } from "@/lib/rpc-manager";
import { invalidateSessionListCache, resolveSessionPathReadOnly, readSessionHeader } from "@/lib/session-reader";
import { invalidateSessionReadCache } from "@/lib/session-read-cache";
import { listWorktrees, resolveProject } from "@/lib/worktree";

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}

function pathMatches(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function parseRelation(value: unknown): WorktreeBindingRelation {
  if (value === "creator" || value === "task-root") return value;
  throw new Error("relation must be creator or task-root");
}

export async function POST(req: Request) {
  try {
    if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
    if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "JSON object body is required" }, { status: 400 });
    }
    const cwd = typeof body.cwd === "string" ? body.cwd : "";
    const worktreePath = typeof body.worktreePath === "string" ? body.worktreePath : "";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    if (!cwd || !worktreePath || !sessionId) {
      return NextResponse.json({ error: "cwd, worktreePath and sessionId are required" }, { status: 400 });
    }
    if (!existsSync(cwd)) return NextResponse.json({ error: "cwd must be an existing directory" }, { status: 400 });
    const relation = parseRelation(body.relation);
    const project = await resolveProject(cwd);
    const worktrees = await listWorktrees(cwd);
    const registeredWorktree = worktrees.find((item) => pathMatches(item.path, worktreePath));
    if (!registeredWorktree) {
      return NextResponse.json({ error: "worktreePath is not a registered worktree of this project" }, { status: 400 });
    }

    const sessionPath = await resolveSessionPathReadOnly(sessionId);
    if (!sessionPath || !existsSync(sessionPath)) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    const header = readSessionHeader(sessionPath);
    if (!header || header.id !== sessionId) return NextResponse.json({ error: "Session identity could not be verified" }, { status: 409 });
    const sessionProject = await resolveProject(header.cwd);
    if (!pathMatches(sessionProject.projectRoot, project.projectRoot)) {
      return NextResponse.json({ error: "Session and worktree belong to different projects" }, { status: 409 });
    }

    const binding = {
      projectRoot: normalizePath(project.projectRoot),
      worktreePath: normalizePath(registeredWorktree.path),
      relation,
    } as const;
    const live = getRpcSession(sessionId);
    let appended = false;
    if (live?.isAlive()) {
      if (live.isShuttingDown?.()) return NextResponse.json({ error: "Session is shutting down" }, { status: 409 });
      if (live.inner.sessionManager.getSessionId() !== sessionId) {
        return NextResponse.json({ error: "Live session identity changed" }, { status: 409 });
      }
      appended = appendWorktreeBinding(live.inner.sessionManager, binding);
    } else {
      const ownership = acquireSessionRuntimeOwnership(sessionPath);
      try {
        const manager = SessionManager.open(sessionPath);
        if (manager.getSessionId() !== sessionId) {
          return NextResponse.json({ error: "Session identity changed while opening" }, { status: 409 });
        }
        appended = appendWorktreeBinding(manager, binding);
      } finally {
        ownership.release();
      }
    }

    invalidateSessionReadCache(sessionPath);
    invalidateSessionListCache();
    emitActivityEvent({ kind: "session", sessionId });
    return NextResponse.json({
      ok: true,
      appended,
      binding: { ...binding, sessionId },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
