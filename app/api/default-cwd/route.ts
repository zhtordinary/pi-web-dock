import { NextResponse } from "next/server";
import { createDefaultCwdDirectory } from "@/lib/default-cwd";
import { isApiRequestAllowed } from "@/lib/request-security";

// POST /api/default-cwd
// Creates ~/pi-cwd/<YYYYMMDD> (local date) if it doesn't exist and returns the path.
// The client then selects it through /api/cwd/validate like any other directory.
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  try {
    const dir = createDefaultCwdDirectory();
    return NextResponse.json({ cwd: dir });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
