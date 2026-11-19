import { NextResponse } from "next/server";
import { existsSync } from "fs";
import {
  addWorktree,
  buildWorktreeGraph,
  findCurrentWorktreePath,
  inspectWorktreeNode,
  listWorktrees,
  removeWorktree,
  renameWorktreeBranch,
  resolveProject,
  worktreeRemovalRequiresForce,
} from "@/lib/worktree";
import { isExistingDirectory } from "@/lib/file-access";
import { projectIdentityKey } from "@/lib/project-identity";
import { filterHiddenSessions } from "@/lib/hidden-filter";
import { listSessionSummaries } from "@/lib/session-reader";
import { assertWorktreeRemovalSafe } from "@/lib/worktree-removal-safety";
import { scanWorktreeAssociations } from "@/lib/worktree-association-scan";
import { readWorktreeAssociationHints, saveWorktreeAssociationHints } from "@/lib/worktree-association-index";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

function validateCwd(cwd: string): NextResponse | null {
  if (!isExistingDirectory(cwd)) return NextResponse.json({ error: "cwd must be an existing directory" }, { status: 400 });
  return null;
}

type MutationBody = Record<string, unknown> & { cwd: string };

/** Shared admission for POST/PATCH/DELETE: trusted JSON request with an allowed, existing cwd. */
async function readMutationBody(req: Request): Promise<MutationBody | NextResponse> {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "JSON object body is required" }, { status: 400 });
  }
  if (typeof body.cwd !== "string" || !body.cwd) {
    return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  }
  const denied = validateCwd(body.cwd);
  if (denied) return denied;
  if (!existsSync(body.cwd)) {
    return NextResponse.json({ error: `Directory does not exist: ${body.cwd}` }, { status: 400 });
  }
  return body as MutationBody;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// GET /api/worktrees?cwd=&graph=1&refresh=1&inspect=
export async function GET(req: Request) {
  try {
    const searchParams = new URL(req.url).searchParams;
    const cwd = searchParams.get("cwd");
    if (!cwd) {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    const denied = validateCwd(cwd);
    if (denied) return denied;

    const inspectPath = searchParams.get("inspect");
    if (inspectPath) {
      try {
        const inspection = await inspectWorktreeNode(cwd, inspectPath);
        return NextResponse.json({ inspection });
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Not a worktree of this repository:")) {
          return NextResponse.json({ error: "inspect path is not a registered worktree" }, { status: 400 });
        }
        throw error;
      }
    }

    const project = await resolveProject(cwd);
    let worktrees: Awaited<ReturnType<typeof listWorktrees>> = [];
    let currentWorktreePath: string | null = null;
    let isGit = true;
    try {
      // For a removed-worktree cwd (session of a deleted worktree), fall back
      // to the inferred project root so the switcher still shows the project.
      worktrees = await listWorktrees(existsSync(cwd) ? cwd : project.projectRoot);
      currentWorktreePath = findCurrentWorktreePath(worktrees, cwd);
    } catch {
      isGit = false;
    }
    const projectKey = projectIdentityKey(project.projectRoot);
    if (searchParams.get("creationHistory") === "1") {
      if (!isGit) return NextResponse.json({ error: "Not a Git repository" }, { status: 400 });
      let inventoryIncomplete = false;
      let summaries: Awaited<ReturnType<typeof listSessionSummaries>>;
      try {
        summaries = await listSessionSummaries({ readOnly: true, requireComplete: true });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "Session inventory is incomplete") throw error;
        inventoryIncomplete = true;
        summaries = await listSessionSummaries({ readOnly: true });
      }
      const sessions = filterHiddenSessions(summaries)
        .filter((session) => (session.projectKey ?? projectIdentityKey(session.projectRoot ?? session.cwd)) === projectKey);
      const paths = worktrees.map((worktree) => worktree.path);
      const prioritySessionId = searchParams.get("sessionId") || undefined;
      const deadline = performance.now() + 80;
      let history = scanWorktreeAssociations(sessions, project.projectRoot, paths, {
        retry: searchParams.get("retry") === "1", prioritySessionId,
      });
      // Yield between bounded slices and stop promptly for other requests.
      for (let slice = 1; slice < 16 && history.progress.running && performance.now() < deadline; slice++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        history = scanWorktreeAssociations(sessions, project.projectRoot, paths, { prioritySessionId });
      }
      const partial = history.partial || inventoryIncomplete;
      const provisionalRecords = partial
        ? readWorktreeAssociationHints(project.projectRoot, sessions, paths)
          .filter((record) => record.sessionId !== prioritySessionId || history.priorityPending)
        : [];
      if (!partial || history.records.length) {
        saveWorktreeAssociationHints(project.projectRoot, sessions, paths, history.records, !partial);
      }
      return NextResponse.json({ ...history, partial, ...(inventoryIncomplete && !history.failure ? { failure: "unavailable" } : {}), provisionalRecords }, { headers: { "Cache-Control": "no-store" } });
    }
    const graph = searchParams.get("graph") === "1" && isGit
      ? await buildWorktreeGraph(existsSync(cwd) ? cwd : project.projectRoot, { forceRefresh: searchParams.get("refresh") === "1" })
      : undefined;
    const sessionCwd = searchParams.get("sessionCwd");
    const sessionWorktreePath = sessionCwd && isExistingDirectory(sessionCwd) ? findCurrentWorktreePath(worktrees, sessionCwd) : null;
    return NextResponse.json({
      projectRoot: project.projectRoot,
      projectKey,
      isGit,
      isTopLevel: project.isTopLevel,
      currentWorktreePath,
      ...(searchParams.has("sessionCwd") ? { sessionWorktreePath } : {}),
      worktrees,
      ...(graph ? { graph: { ...graph, projectKey } } : {}),
      ...(graph?.githubRepository ? { githubRepository: graph.githubRepository } : {}),
      ...(graph?.githubUrl ? { githubUrl: graph.githubUrl } : {}),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/worktrees  body: { cwd, branch }  →  { path, branch }
export async function POST(req: Request) {
  const body = await readMutationBody(req);
  if (body instanceof NextResponse) return body;
  const { branch } = body;
  if (typeof branch !== "string" || !branch.trim()) {
    return NextResponse.json({ error: "branch is required" }, { status: 400 });
  }
  try {
    return NextResponse.json(await addWorktree(body.cwd, branch));
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 400 });
  }
}

// PATCH /api/worktrees  body: { cwd, path, branch }  →  { path, branch }
export async function PATCH(req: Request) {
  const body = await readMutationBody(req);
  if (body instanceof NextResponse) return body;
  const { path, branch } = body;
  if (typeof path !== "string" || !path) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }
  if (typeof branch !== "string" || !branch.trim()) {
    return NextResponse.json({ error: "branch is required" }, { status: 400 });
  }
  try {
    return NextResponse.json(await renameWorktreeBranch(body.cwd, path, branch));
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 400 });
  }
}

// DELETE /api/worktrees  body: { cwd, path }
export async function DELETE(req: Request) {
  const body = await readMutationBody(req);
  if (body instanceof NextResponse) return body;
  const { path } = body;
  if (typeof path !== "string" || !path) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }
  try {
    const identity = await assertWorktreeRemovalSafe(body.cwd, path);
    if (req.signal.aborted) throw new Error("Worktree safety unknown: the request was cancelled");
    await removeWorktree(body.cwd, path, false, identity);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = errorMessage(error);
    // Report dirty or unavailable safety evidence without offering a force retry.
    const dirty = worktreeRemovalRequiresForce(message);
    const unsafe = message.startsWith("Worktree removal refused:") || message.startsWith("Worktree safety unknown:");
    return NextResponse.json({ error: message, dirty }, { status: dirty || unsafe ? 409 : 400 });
  }
}
