import { NextResponse } from "next/server";
import type { SkillViewScope } from "@/lib/api-types";
import { getSkillAnalysisJob, startSkillAnalysisJob } from "@/lib/skill-analysis-jobs";
import {
  analyzeRequestedSkill,
  readSkillAnalysisScope,
  SkillAnalysisRequestError,
  validateSkillAnalysisScope,
} from "@/lib/skill-analysis-service";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

function errorResponse(error: unknown): NextResponse {
  if (error instanceof SkillAnalysisRequestError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
}

// GET /api/skills/analyze?cwd=...&scope=...
// Returns the persisted batch state and resumes a process-restart survivor.
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  try {
    const search = new URL(req.url).searchParams;
    const cwd = search.get("cwd");
    const scope: SkillViewScope = readSkillAnalysisScope(search.get("scope"));
    await validateSkillAnalysisScope(cwd, scope);
    return NextResponse.json(
      { job: cwd ? getSkillAnalysisJob(cwd, scope) : null },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

// POST /api/skills/analyze body: { cwd, scope, filePath }
// The single-skill form remains compatible with existing callers.
// POST /api/skills/analyze body: { cwd, scope, filePaths }
// Starts a persisted server-side batch and returns immediately.
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as {
      cwd?: unknown;
      scope?: unknown;
      filePath?: unknown;
      filePaths?: unknown;
    };
    const cwd = typeof body.cwd === "string" ? body.cwd : "";
    const scope = readSkillAnalysisScope(body.scope);

    if (Array.isArray(body.filePaths)) {
      const job = await startSkillAnalysisJob(cwd, scope, body.filePaths);
      return NextResponse.json({ job }, { status: job.status === "running" ? 202 : 200 });
    }

    if (!cwd || typeof body.filePath !== "string" || !body.filePath) {
      return NextResponse.json({ error: "cwd and filePath are required" }, { status: 400 });
    }
    return NextResponse.json(await analyzeRequestedSkill(cwd, scope, body.filePath));
  } catch (error) {
    return errorResponse(error);
  }
}
