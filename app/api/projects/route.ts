import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { emitActivityEvent } from "@/lib/activity-events";
import { addKnownProject, listKnownProjects, removeKnownProject } from "@/lib/known-projects";
import { getProjectIdentity, projectIdentityKey, projectIdentityKeys } from "@/lib/project-identity";
import { readHiddenState } from "@/lib/hidden-state";
import { localDeviceId } from "@/lib/hidden-filter";
import { hasSubprojects, listSubprojects } from "@/lib/subproject-state";

export const dynamic = "force-dynamic";

function allProjectIdentityKeys(path: string): Set<string> {
  return new Set([
    ...projectIdentityKeys(path),
    projectIdentityKey(path),
    // DELETE must still recognize a cached/legacy Git key after a directory
    // was removed, so resolve this identity independently of path aliases.
    getProjectIdentity(path).key,
  ]);
}

export async function GET() {
  const hidden = readHiddenState();
  const deviceHidden = hidden.devices.includes(localDeviceId());
  const projects = deviceHidden ? [] : listKnownProjects().filter((project) => {
    const keys = allProjectIdentityKeys(project.path);
    return ![...keys].some((key) => hidden.projects.includes(key));
  });
  return NextResponse.json({ projects, subprojects: listSubprojects() });
}

function normalizePath(input: unknown): { path?: string; error?: string } {
  if (typeof input !== "string" || !input.trim()) return { error: "cwd is required" };
  const path = resolve(input.trim());
  if (!existsSync(path)) return { error: "directory does not exist" };
  return { path };
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null) as { cwd?: unknown } | null;
    const { path, error } = normalizePath(body?.cwd);
    if (error || !path) return NextResponse.json({ error: error ?? "invalid cwd" }, { status: 400 });
    return NextResponse.json({ projects: addKnownProject(path), subprojects: listSubprojects() });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const body = await req.json().catch(() => null) as { cwd?: unknown } | null;
    if (typeof body?.cwd !== "string" || !body.cwd.trim()) {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    const path = resolve(body.cwd.trim());
    const projectKeys = allProjectIdentityKeys(path);
    if ([...projectKeys].some((projectKey) => hasSubprojects(projectKey))) {
      return NextResponse.json({ error: "Project has subprojects; remove them first", code: "project_has_subprojects" }, { status: 409 });
    }
    const wasSaved = listKnownProjects().some((project) => project.path === path);
    const projects = removeKnownProject(path);
    if (wasSaved) emitActivityEvent({ kind: "session" });
    return NextResponse.json({ projects, subprojects: listSubprojects() });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
