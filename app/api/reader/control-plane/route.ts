import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createControlPlane, ControlPlaneError, readControlPlaneJson } from "@/lib/reader-control-plane";
import { inspectSettings, mutateSettings, validateSettingsChange } from "@/lib/reader-control-plane-settings";
import { isExistingDirectory } from "@/lib/file-access";
import { localDeviceIdentity, readActivityConfig } from "@/lib/activity-peers";
import { LIVE_EVENT_BOOT_ID } from "@/lib/live-agent-events";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";
const control = createControlPlane({
  deviceId: () => localDeviceIdentity(readActivityConfig(), new Date().toISOString()).id,
  bootId: () => LIVE_EVENT_BOOT_ID,
  globalCwd: getAgentDir,
  authorizeCwd: async (cwd) => isExistingDirectory(cwd),
  inspectSettings, mutateSettings, validateSettingsChange,
});
let activeRequests = 0;
async function handle(req: Request, method: "GET" | "POST") {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ code: "request_denied" }, { status: 403 });
  if (method === "POST" && !hasJsonContentType(req)) return NextResponse.json({ code: "content_type" }, { status: 415 });
  if (activeRequests >= 8) return NextResponse.json({ code: "rate_limited", retryAfterMs: 1000 }, { status: 429, headers: { "Retry-After": "1" } });
  activeRequests++;
  try {
    const params = new URL(req.url).searchParams;
    if (method === "GET" && ([...params].length > 10 || req.url.length > 5000 || [...params.keys()].some((key) => params.getAll(key).length > 1))) throw new Error("Invalid query");
    const body = method === "GET" ? Object.fromEntries(params) : await readControlPlaneJson(req);
    const caller = req.headers.get("x-pi-reader-control-caller")?.slice(0, 160) ?? null;
    const result = await control.dispatch(method, body, caller);
    let responseBody: unknown = result.body;
    if (Buffer.byteLength(JSON.stringify(responseBody), "utf8") > 128 * 1024) {
      const full = result.body as Record<string, unknown>;
      responseBody = { schemaVersion: 1, success: full.success, accepted: full.accepted, outcome: full.outcome,
        receipt: full.receipt, truncated: true, code: "response_budget_exceeded", nextAction: "inspect_configuration_receipt", maxBytes: 128 * 1024 };
    }
    return NextResponse.json(responseBody, { status: result.status, headers: { "Cache-Control": "no-store", ...(result.status === 429 ? { "Retry-After": "1" } : {}) } });
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 400;
    return NextResponse.json({ success: false, accepted: false, code: error instanceof ControlPlaneError ? error.code : "invalid_request", outcome: "blocked" }, { status });
  } finally { activeRequests--; }
}
export async function GET(req: Request) { return handle(req, "GET"); }
export async function POST(req: Request) { return handle(req, "POST"); }
