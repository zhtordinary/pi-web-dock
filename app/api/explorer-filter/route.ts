import { NextResponse } from "next/server";
import {
  loadExplorerFilterForProject,
  saveExplorerFilterForProject,
} from "@/lib/explorer-filter-store";
import type { ExplorerFilterSettings } from "@/lib/explorer-filter";

export const dynamic = "force-dynamic";

// GET /api/explorer-filter?cwd=<project path>
// Returns { filter } for the project, or { filter: null } when the device
// settings file has no record for it yet (client then migrates browser
// storage or falls back to defaults).
export async function GET(req: Request) {
  const cwd = new URL(req.url).searchParams.get("cwd") ?? "";
  return NextResponse.json({ filter: loadExplorerFilterForProject(cwd) });
}

// POST /api/explorer-filter  { cwd, settings }
export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: unknown; settings?: unknown };
    if (typeof body.cwd !== "string") {
      return NextResponse.json({ error: "cwd required" }, { status: 400 });
    }
    if (!body.settings || typeof body.settings !== "object" || Array.isArray(body.settings)) {
      return NextResponse.json({ error: "settings required" }, { status: 400 });
    }
    saveExplorerFilterForProject(body.cwd, body.settings as ExplorerFilterSettings);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
