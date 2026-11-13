import fs from "fs";
import { NextRequest, NextResponse } from "next/server";
import { isWindowsAbsolutePath } from "@/lib/paths";
import { getGitStatus } from "@/lib/git-changes";

export async function GET(request: NextRequest) {
  try {
    const cwd = request.nextUrl.searchParams.get("cwd")?.trim() ?? "";
    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(cwd);
    } catch {
      return NextResponse.json({ error: "Directory not found" }, { status: 404 });
    }
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: "Not a directory" }, { status: 400 });
    }
    return NextResponse.json(await getGitStatus(cwd));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
