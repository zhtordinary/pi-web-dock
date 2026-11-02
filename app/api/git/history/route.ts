import fs from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import { getGitCommitDetail, getGitHistory } from "@/lib/git-changes";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

function parseLimit(value: string | null): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 20;
}

export async function GET(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const cwd = request.nextUrl.searchParams.get("cwd")?.trim() ?? "";
    const hash = request.nextUrl.searchParams.get("hash")?.trim() ?? "";
    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
    }
    if (hash && !/^[0-9a-f]{7,64}$/i.test(hash)) {
      return NextResponse.json({ error: "hash must be a Git commit hash" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(cwd, allowedRoots) || !isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(cwd);
    } catch {
      return NextResponse.json({ error: "Directory not found" }, { status: 404 });
    }
    if (!stat.isDirectory()) return NextResponse.json({ error: "Not a directory" }, { status: 400 });

    if (hash) {
      const detail = await getGitCommitDetail(cwd, hash);
      if (!detail) return NextResponse.json({ error: "Commit not found" }, { status: 404 });
      return NextResponse.json({ detail }, { headers: { "Cache-Control": "no-store" } });
    }

    const history = await getGitHistory(cwd, parseLimit(request.nextUrl.searchParams.get("limit")));
    if (history === null) return NextResponse.json({ error: "This folder is not a Git repository" }, { status: 409 });
    return NextResponse.json({ history }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
