import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import { emitActivityEvent } from "@/lib/activity-events";
import { listAllSessions, listArchivedSessions } from "@/lib/session-reader";
import { projectIdentityKeys } from "@/lib/project-identity";
import { listKnownProjects } from "@/lib/known-projects";
import {
  canonicalProjectKey,
  createSubproject,
  deleteSubproject,
  projectKeysEqual,
  renameSubproject,
  setSubprojectHidden,
  setSubprojectAutoHideEmpty,
  readSubprojectState,
  setSubprojectSort,
  SubprojectDomainError,
} from "@/lib/subproject-state";

export const dynamic = "force-dynamic";

async function isKnownProjectKey(projectKeyInput: string): Promise<boolean> {
  const trimmed = projectKeyInput.trim();
  if (!trimmed) return false;

  const candidateKeys = new Set([
    trimmed,
    canonicalProjectKey(trimmed),
    ...projectIdentityKeys(trimmed),
  ]);

  // 1. In-memory check against existing subproject state (instant)
  const state = readSubprojectState();
  for (const item of [...state.subprojects, ...(state.sortSettings ?? []), ...state.assignments]) {
    for (const key of candidateKeys) {
      if (projectKeysEqual(item.projectKey, key)) return true;
    }
  }

  // 2. In-memory check against known projects list (instant)
  for (const project of listKnownProjects()) {
    const projectKeys = projectIdentityKeys(project.path);
    for (const pk of projectKeys) {
      if (candidateKeys.has(pk)) return true;
      for (const ck of candidateKeys) {
        if (projectKeysEqual(pk, ck)) return true;
      }
    }
  }

  // 3. Filesystem existence check for directory path (instant)
  const rawPath = trimmed.startsWith("path:") ? trimmed.slice("path:".length) : trimmed;
  if (existsSync(rawPath)) return true;

  // 4. In-memory cached session lists if already loaded
  if (globalThis.__piSessionListCache) {
    for (const session of globalThis.__piSessionListCache.data) {
      if (session.projectKey && candidateKeys.has(session.projectKey)) return true;
      const root = session.projectRoot ?? session.cwd;
      if (root) {
        for (const rk of projectIdentityKeys(root)) {
          if (candidateKeys.has(rk)) return true;
        }
      }
    }
  }

  // 5. Fallback: only if all instant checks fail, perform a cold session scan
  const keys = await knownProjectKeys();
  for (const key of candidateKeys) {
    if (keys.has(key)) return true;
  }
  return false;
}

async function knownProjectKeys(): Promise<Set<string>> {
  const [active, archived] = await Promise.all([listAllSessions(), listArchivedSessions()]);
  const keys = new Set<string>();
  for (const session of [...active, ...archived]) {
    if (session.projectKey) {
      for (const k of projectIdentityKeys(session.projectKey)) keys.add(k);
    }
    const root = session.projectRoot ?? session.cwd;
    if (root) {
      for (const k of projectIdentityKeys(root)) keys.add(k);
    }
  }
  for (const project of listKnownProjects()) {
    for (const k of projectIdentityKeys(project.path)) keys.add(k);
  }
  return keys;
}

function domainErrorResponse(error: unknown, fallbackStatus = 500) {
  if (error instanceof SubprojectDomainError) {
    const status = error.code === "subproject_required"
      ? 400
      : error.code === "subproject_not_found" ? 404 : 409;
    return NextResponse.json({ error: error.message, code: error.code }, { status });
  }
  const message = error instanceof Error ? error.message : String(error);
  return NextResponse.json({ error: message }, { status: fallbackStatus });
}

export async function GET() {
  try {
    return NextResponse.json(readSubprojectState(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return domainErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null) as { projectKey?: unknown; label?: unknown } | null;
    if (typeof body?.projectKey !== "string" || !body.projectKey.trim()) {
      return NextResponse.json({ error: "projectKey is required", code: "subproject_required" }, { status: 400 });
    }
    if (!(await isKnownProjectKey(body.projectKey))) {
      return NextResponse.json({ error: "Unknown project", code: "unknown_project" }, { status: 409 });
    }
    const subproject = createSubproject(body.projectKey, typeof body.label === "string" ? body.label : "");
    emitActivityEvent({ kind: "session" });
    return NextResponse.json({ subproject }, { status: 201 });
  } catch (error) {
    return domainErrorResponse(error);
  }
}

export async function PATCH(req: Request) {
  try {
    const body = await req.json().catch(() => null) as { id?: unknown; label?: unknown; hidden?: unknown } | null;
    if (typeof body?.id !== "string" || (typeof body.label !== "string" && typeof body.hidden !== "boolean")) {
      return NextResponse.json({ error: "id and label or hidden are required", code: "subproject_required" }, { status: 400 });
    }
    const subproject = typeof body.hidden === "boolean"
      ? setSubprojectHidden(body.id, body.hidden)
      : renameSubproject(body.id, body.label as string);
    emitActivityEvent({ kind: "session" });
    return NextResponse.json({ subproject });
  } catch (error) {
    return domainErrorResponse(error);
  }
}

export async function PUT(req: Request) {
  try {
    const body = await req.json().catch(() => null) as { projectKey?: unknown; mode?: unknown; order?: unknown; autoHideEmptySubprojects?: unknown } | null;
    if (typeof body?.projectKey !== "string" || !body.projectKey.trim()) {
      return NextResponse.json({ error: "projectKey is required", code: "subproject_required" }, { status: 400 });
    }
    if (body.mode !== undefined && typeof body.mode !== "string") {
      return NextResponse.json({ error: "mode must be a string", code: "subproject_required" }, { status: 400 });
    }
    if (body.autoHideEmptySubprojects !== undefined && typeof body.autoHideEmptySubprojects !== "boolean") {
      return NextResponse.json({ error: "autoHideEmptySubprojects must be a boolean", code: "subproject_required" }, { status: 400 });
    }
    if (body.mode === undefined && body.autoHideEmptySubprojects === undefined) {
      return NextResponse.json({ error: "mode or autoHideEmptySubprojects is required", code: "subproject_required" }, { status: 400 });
    }
    if (!(await isKnownProjectKey(body.projectKey))) {
      return NextResponse.json({ error: "Unknown project", code: "unknown_project" }, { status: 409 });
    }
    if (body.order !== undefined && (!Array.isArray(body.order) || !body.order.every((id) => typeof id === "string"))) {
      return NextResponse.json({ error: "order must be an array of ids", code: "subproject_required" }, { status: 400 });
    }
    const sortSetting = body.mode === undefined
      ? setSubprojectAutoHideEmpty(body.projectKey, body.autoHideEmptySubprojects as boolean)
      : setSubprojectSort(body.projectKey, body.mode, body.order as string[] | undefined, body.autoHideEmptySubprojects as boolean | undefined);
    emitActivityEvent({ kind: "session" });
    return NextResponse.json({ sortSetting });
  } catch (error) {
    return domainErrorResponse(error);
  }
}

export async function DELETE(req: Request) {
  try {
    const body = await req.json().catch(() => null) as { id?: unknown } | null;
    if (typeof body?.id !== "string") return NextResponse.json({ error: "id is required", code: "subproject_required" }, { status: 400 });
    const state = deleteSubproject(body.id);
    emitActivityEvent({ kind: "session" });
    return NextResponse.json({ state });
  } catch (error) {
    return domainErrorResponse(error);
  }
}
