import { NextResponse } from "next/server";
import { getAllowedFileRoots } from "@/lib/file-access";
import { getFilePermissionsPath, readFilePermissionsSnapshot, updateFilePermissions } from "@/lib/file-permissions";
import { ControlPlaneError, readControlPlaneJson } from "@/lib/reader-control-plane";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "no-store" };

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  try {
    await getAllowedFileRoots();
    return NextResponse.json({ ...readFilePermissionsSnapshot(), path: getFilePermissionsPath() }, { headers: noStore });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500, headers: noStore });
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const body = await readControlPlaneJson(req, 10_000, 1024 * 1024);
    if (typeof body.revision !== "string" || !/^[a-f0-9]{64}$/.test(body.revision)) {
      return NextResponse.json({ error: "A valid configuration revision is required" }, { status: 400, headers: noStore });
    }
    if (body.action !== "save" && body.action !== "restore") {
      return NextResponse.json({ error: "action must be save or restore" }, { status: 400, headers: noStore });
    }
    const next = body.action === "restore" ? "restore" : { read: body.read, write: body.write };
    const result = updateFilePermissions(body.revision, next as Parameters<typeof updateFilePermissions>[1]);
    return NextResponse.json({ ...result, path: getFilePermissionsPath() }, { headers: noStore });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    const status = error instanceof ControlPlaneError ? error.status : code === "revision_conflict" ? 409 : code === "invalid_permissions" ? 400 : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error), ...(code ? { code } : {}) }, { status, headers: noStore });
  }
}
