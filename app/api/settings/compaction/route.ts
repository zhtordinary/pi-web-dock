import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

function readSettings() {
  // This endpoint owns the device-wide default. Do not merge a project's
  // compaction override into the value shown or written here.
  return SettingsManager.create(process.cwd(), getAgentDir(), { projectTrusted: false });
}

function readGlobalCompactionEnabled(settings: ReturnType<typeof readSettings>): boolean {
  return settings.getGlobalSettings().compaction?.enabled ?? true;
}

export async function GET() {
  try {
    const settings = readSettings();
    return NextResponse.json({ enabled: readGlobalCompactionEnabled(settings) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
    }
    const settings = readSettings();
    settings.setCompactionEnabled(body.enabled);
    await settings.flush();
    return NextResponse.json({ enabled: readGlobalCompactionEnabled(settings) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
