import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { NextResponse } from "next/server";
import { resolveModelDiscoveryAuth } from "@/lib/model-discovery-auth";
import {
  buildModelDiscoveryHeaders,
  buildModelsListUrl,
  parseDiscoveredModels,
} from "@/lib/model-discovery";

export const dynamic = "force-dynamic";

const DISCOVERY_TIMEOUT_MS = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return Response.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const body = await req.json() as { providerName?: unknown; provider?: unknown };
    const providerName = typeof body.providerName === "string" ? body.providerName.trim() : "";
    if (!providerName) return NextResponse.json({ error: "providerName is required" }, { status: 400 });
    if (!isRecord(body.provider)) return NextResponse.json({ error: "provider is required" }, { status: 400 });

    const configuredBaseUrl = typeof body.provider.baseUrl === "string" ? body.provider.baseUrl.trim() : "";
    const configuredApi = typeof body.provider.api === "string" && body.provider.api ? body.provider.api : "";

    let auth: Awaited<ReturnType<typeof resolveModelDiscoveryAuth>>;
    try {
      auth = await resolveModelDiscoveryAuth(providerName, body.provider);
    } catch (error) {
      // Without a configured Base URL, pi's catalog was the only other source of
      // one; for a custom provider it fails with an error about the placeholder model.
      if (!configuredBaseUrl) return NextResponse.json({ error: "Base URL is required" }, { status: 400 });
      throw error;
    }
    if (typeof body.provider.apiKey === "string" && body.provider.apiKey.trim() && !auth.apiKey) {
      return NextResponse.json({ error: `No API key found for "${providerName}"` }, { status: 400 });
    }

    // Fall back to pi's provider catalog so built-in providers, and entries
    // that only list models, do not have to repeat the upstream base URL.
    const baseUrl = configuredBaseUrl || auth.baseUrl || "";
    if (!baseUrl) return NextResponse.json({ error: "Base URL is required" }, { status: 400 });
    const api = configuredApi || auth.api || "openai-completions";

    let endpoint: URL;
    try {
      endpoint = buildModelsListUrl(baseUrl, api);
    } catch {
      return NextResponse.json({ error: "Base URL is invalid" }, { status: 400 });
    }

    const response = await fetch(endpoint, {
      cache: "no-store",
      headers: buildModelDiscoveryHeaders(api, auth.apiKey, auth.headers),
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    const responseText = await response.text();
    if (!response.ok) {
      return NextResponse.json({
        error: responseText.slice(0, 500) || `Upstream returned HTTP ${response.status}`,
        status: response.status,
      }, { status: 502 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch {
      return NextResponse.json({ error: "Upstream model list was not valid JSON" }, { status: 502 });
    }
    const models = parseDiscoveredModels(payload);
    if (models.length === 0) {
      return NextResponse.json({ error: "No models found in the upstream response" }, { status: 502 });
    }

    return NextResponse.json({ models, endpoint: endpoint.toString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof DOMException && error.name === "TimeoutError" ? 504 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
