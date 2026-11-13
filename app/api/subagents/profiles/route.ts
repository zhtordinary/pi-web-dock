import { existsSync } from "node:fs";
import { realpathSync } from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import {
  listSubagentProfiles,
  saveSubagentProfile,
  deleteSubagentProfile,
  type SubagentProfile,
} from "@/lib/subagent-profiles";
import { isExistingDirectory } from "@/lib/file-access";
import { disabledBuiltInSubagents, readSubagentProfileOrder, writeDisabledBuiltInSubagent, writeBuiltInSubagentOverride } from "@/lib/subagent-settings";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { writePiSubagentOverride } from "@/lib/pi-subagent-settings";
import { VALID_THINKING_LEVELS } from "@/lib/subagent-profile-types";
import { getRpcSession } from "@/lib/rpc-manager";
import { orderSubagentProfiles } from "@/lib/subagent-order";

export const dynamic = "force-dynamic";

async function validateCwd(rawCwd: unknown): Promise<string> {
  if (typeof rawCwd !== "string" || !rawCwd || !existsSync(rawCwd)) {
    throw new Error("Valid cwd required");
  }
  if (!isExistingDirectory(rawCwd)) {
    throw new Error("Valid cwd required");
  }
  return rawCwd;
}

function validateScope(rawScope: unknown): "global" | "project" {
  if (rawScope !== "global" && rawScope !== "project") {
    throw new Error("scope must be global or project");
  }
  return rawScope;
}

function validateToggleScope(rawScope: unknown): "global" | "project" | "builtin" | "runtime" {
  if (rawScope === "builtin" || rawScope === "runtime" || rawScope === "global" || rawScope === "project") return rawScope;
  throw new Error("scope must be global, project, or builtin");
}

function hasOwn(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function overridePatchValue(value: unknown): string | false | null {
  if (value === null) return null;
  if (value === false) return false;
  return value as string;
}

function projectProfiles(cwd: string, parentProvider?: string): SubagentProfile[] {
  const disabled = disabledBuiltInSubagents();
  return listSubagentProfiles(cwd, parentProvider ? { parentProvider } : {}).map((profile) =>
    profile.scope === "builtin"
      ? { ...profile, enabled: profile.enabled && !disabled.has(profile.name.toLowerCase()) }
      : profile,
  );
}

function findProfile(profiles: SubagentProfile[], scope: string, name: string): SubagentProfile | undefined {
  const normalized = name.toLowerCase();
  return profiles.find((profile) => profile.scope === scope && profile.name.toLowerCase() === normalized);
}

async function verifiedParentProvider(cwd: string, rawSessionId: unknown): Promise<string | undefined> {
  if (typeof rawSessionId !== "string" || !rawSessionId.trim()) return undefined;
  const session = getRpcSession(rawSessionId);
  if (!session?.isAlive()) return undefined;
  try {
    if (realpathSync(session.cwd) !== realpathSync(cwd)) return undefined;
    const snapshot = await session.send({ type: "get_state" });
    const model = snapshot && typeof snapshot === "object" && "model" in snapshot
      ? (snapshot as { model?: unknown }).model
      : undefined;
    if (!model || typeof model !== "object") return undefined;
    const provider = (model as { provider?: unknown }).provider;
    return typeof provider === "string" && provider.trim() ? provider.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function profileAfterWrite(cwd: string, scope: string, name: string, sessionId?: unknown): Promise<SubagentProfile | undefined> {
  const parentProvider = await verifiedParentProvider(cwd, sessionId);
  return findProfile(projectProfiles(cwd, parentProvider), scope, name);
}

export async function GET(req: NextRequest) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const url = new URL(req.url);
    const cwd = await validateCwd(url.searchParams.get("cwd"));
    const parentProvider = await verifiedParentProvider(cwd, url.searchParams.get("sessionId"));
    return NextResponse.json({ profiles: orderSubagentProfiles(projectProfiles(cwd, parentProvider), readSubagentProfileOrder()) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message === "Access denied" ? 403 : 400 });
  }
}

export async function PUT(req: NextRequest) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ error: "JSON object required" }, { status: 400 });
    }
    const body = parsed as Record<string, unknown>;
    const cwd = await validateCwd(body.cwd);
    const scope = validateScope(body.scope);
    if (!body.profile || typeof body.profile !== "object" || Array.isArray(body.profile) || typeof (body.profile as Record<string, unknown>).name !== "string") {
      return NextResponse.json({ error: "profile required" }, { status: 400 });
    }

    const saved = saveSubagentProfile(cwd, scope, body.profile as SubagentProfile);
    return NextResponse.json({ profile: saved });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message === "Access denied" ? 403 : 400 });
  }
}

export async function PATCH(req: NextRequest) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ error: "JSON object required" }, { status: 400 });
    }
    const body = parsed as Record<string, unknown>;
    const cwd = await validateCwd(body.cwd);
    const scope = validateToggleScope(body.scope);
    if (typeof body.name !== "string") {
      return NextResponse.json({ error: "name required" }, { status: 400 });
    }

    const hasEnabled = hasOwn(body, "enabled");
    const hasModelPatch = hasOwn(body, "model");
    const hasThinkingPatch = hasOwn(body, "thinking");
    if (hasEnabled && typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
    }
    if ((hasModelPatch || hasThinkingPatch) && scope !== "builtin" && scope !== "runtime") {
      return NextResponse.json({ error: "model or thinking is only supported for builtin or runtime" }, { status: 400 });
    }
    for (const field of ["model", "thinking"] as const) {
      if (!hasOwn(body, field)) continue;
      const value = body[field];
      if (value !== null && value !== false && typeof value !== "string") {
        return NextResponse.json({ error: `${field} must be a string, false, or null` }, { status: 400 });
      }
      if (value === false && scope !== "runtime") {
        return NextResponse.json({ error: `${field}=false is only supported for native runtime agents` }, { status: 400 });
      }
      if (field === "thinking" && typeof value === "string" && value !== "" && !(VALID_THINKING_LEVELS as readonly string[]).includes(value)) {
        return NextResponse.json({ error: "thinking must be one of off, minimal, low, medium, high, xhigh, or max" }, { status: 400 });
      }
    }

    if (scope === "runtime" && hasEnabled) {
      return NextResponse.json({ error: "enabled is not supported for runtime agents" }, { status: 400 });
    }
    if (scope !== "builtin" && scope !== "runtime" && !hasEnabled) {
      return NextResponse.json({ error: "enabled required" }, { status: 400 });
    }
    if (scope === "runtime" && !hasModelPatch && !hasThinkingPatch) {
      return NextResponse.json({ error: "model or thinking is required" }, { status: 400 });
    }
    if (scope === "builtin" && !hasEnabled && !hasModelPatch && !hasThinkingPatch) {
      return NextResponse.json({ error: "enabled, model, or thinking is required" }, { status: 400 });
    }

    const parentProvider = await verifiedParentProvider(cwd, body.sessionId);
    const profiles = projectProfiles(cwd, parentProvider);
    const target = findProfile(profiles, scope, body.name);
    if (!target) {
      return NextResponse.json({ error: "Agent profile not found" }, { status: 404 });
    }

    if (scope === "runtime") {
      if (target.runtimeKind !== "native") {
        return NextResponse.json({ error: "External CLI agents own their model and thinking configuration" }, { status: 400 });
      }
      writePiSubagentOverride(target.name, {
        ...(hasModelPatch ? { model: overridePatchValue(body.model) } : {}),
        ...(hasThinkingPatch ? { thinking: overridePatchValue(body.thinking) } : {}),
      });
      const profile = await profileAfterWrite(cwd, scope, target.name, body.sessionId);
      if (!profile) return NextResponse.json({ error: "Agent profile disappeared after write" }, { status: 500 });
      return NextResponse.json({ profile });
    }

    if (scope === "builtin") {
      if (hasEnabled) writeDisabledBuiltInSubagent(target.name, !(body.enabled as boolean));
      if (hasModelPatch || hasThinkingPatch) {
        writeBuiltInSubagentOverride(target.name, {
          ...(hasModelPatch ? { model: body.model === null ? null : body.model as string } : {}),
          ...(hasThinkingPatch ? { thinking: body.thinking === null ? null : body.thinking as string } : {}),
        });
      }
      const profile = await profileAfterWrite(cwd, scope, target.name, body.sessionId);
      if (!profile) return NextResponse.json({ error: "Agent profile disappeared after write" }, { status: 500 });
      return NextResponse.json({ profile });
    }

    const updated = saveSubagentProfile(cwd, scope, { ...target, enabled: body.enabled as boolean });
    const profile = await profileAfterWrite(cwd, scope, updated.name, body.sessionId);
    return NextResponse.json({ profile: profile ?? updated });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message === "Access denied" ? 403 : 400 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ error: "JSON object required" }, { status: 400 });
    }
    const body = parsed as Record<string, unknown>;
    const cwd = await validateCwd(body.cwd);
    const scope = validateScope(body.scope);
    if (typeof body.name !== "string") {
      return NextResponse.json({ error: "name required" }, { status: 400 });
    }

    deleteSubagentProfile(cwd, scope, body.name);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message === "Access denied" ? 403 : 400 });
  }
}
