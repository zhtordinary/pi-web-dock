import { NextResponse } from "next/server";
import { existsSync } from "fs";
import path from "path";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { setGlobalSkillInvocationOverride } from "@/lib/skill-invocation-overrides";
import {
  setGlobalSkillInvocationMode,
  setProjectSkillInvocationMode,
} from "@/lib/skill-policy";
import { loadSkillsWithInstallInfo } from "@/lib/skills-service";
import {
  clearGlobalPluginSkillFilter,
  setGlobalPluginSkillFilter,
} from "@/lib/plugin-overrides";
import {
  clearProjectPackageResourceOverride,
  clearGlobalTopLevelSkillOverride,
  clearProjectTopLevelOverride,
  setGlobalTopLevelSkillOverride,
  setProjectPackageResourceOverride,
  setProjectTopLevelOverride,
} from "@/lib/project-resource-policy";
import type { SkillInvocationMode, SkillViewScope, SkillUseState, SkillStateSnapshot } from "@/lib/api-types";
import { isExistingDirectory } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getProjectTrustStatus } from "@/lib/project-trust";
import {
  getPluginPackageIdentity,
} from "@/lib/plugin-project-status";
import { isDisabledPluginPackage, writeSkillStateSettings } from "@/lib/skill-state-settings";

type PluginSkillAction = "set_plugin_skill" | "clear_plugin_skill";
type GlobalSkillInvocationAction = "set_global_skill_invocation";
type SkillResourceAction = "set_global_skill_resource" | "clear_global_skill_resource";
type ProjectResourceAction = "set_project_resource" | "clear_project_resource";
type SkillInvocationModeAction = "set_skill_invocation_mode" | "clear_skill_invocation_mode";

function readScope(scope: unknown): SkillViewScope {
  return scope === "project" ? "project" : "global";
}

function isSafeResourceKey(resourceKey: string): boolean {
  return Boolean(resourceKey)
    && !resourceKey.startsWith("/")
    && !resourceKey.includes("..")
    && !resourceKey.includes("\0");
}

async function patchPluginSkill(body: {
  action: PluginSkillAction;
  cwd?: string;
  filePath?: string;
  source?: string;
  resourceKey?: string;
  enabled?: boolean;
  scope?: SkillViewScope;
  viewScope?: SkillViewScope;
}): Promise<NextResponse> {
  if (!body.cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
  if (!isExistingDirectory(body.cwd)) {
    return NextResponse.json({ error: "cwd must be an existing directory" }, { status: 400 });
  }
  const targetScope = readScope(body.scope);
  const viewScope = body.viewScope ? readScope(body.viewScope) : targetScope;
  const source = body.source?.trim() ?? "";
  const resourceKey = body.resourceKey?.trim().replaceAll("\\", "/") ?? "";
  if (!source || !isSafeResourceKey(resourceKey)) {
    return NextResponse.json({ error: "source and resourceKey required" }, { status: 400 });
  }
  const agentDir = getAgentDir();
  const projectTrust = getProjectTrustStatus(body.cwd, agentDir);
  if (targetScope === "project" && !projectTrust.trusted) {
    return NextResponse.json(
      { error: "Project resources must be trusted before modifying project skills" },
      { status: 403 },
    );
  }
  const current = await loadSkillsWithInstallInfo(body.cwd, viewScope);
  const candidatePolicyKeys = new Set(["user", "project"].map((scope) => {
    try {
      return `package:${getPluginPackageIdentity(source, {
        cwd: body.cwd,
        agentDir,
        scope: scope as "user" | "project",
      })}:${resourceKey}`;
    } catch {
      return "";
    }
  }));
  const fileTarget = body.filePath
    ? current.skills.find((skill) => path.resolve(skill.filePath) === path.resolve(body.filePath!))
    : undefined;
  if (body.filePath && !fileTarget) {
    return NextResponse.json({ error: "Skill filePath not found in this project" }, { status: 404 });
  }
  const packageTarget = current.skills.find((skill) =>
    skill.sourceInfo?.origin === "package"
    && skill.pluginResourceKey === resourceKey
    && Boolean(skill.policyKey && candidatePolicyKeys.has(skill.policyKey)),
  );
  if (fileTarget && (!packageTarget || path.resolve(fileTarget.filePath) !== path.resolve(packageTarget.filePath))) {
    return NextResponse.json(
      { error: "filePath and package identity identify different Skills" },
      { status: 409 },
    );
  }
  const target = packageTarget;
  if (!target) return NextResponse.json({ error: "Plugin skill not found" }, { status: 404 });
  if (targetScope === "global" && target.sourceInfo.scope !== "user") {
    return NextResponse.json({ error: "Global skill changes require a global plugin skill" }, { status: 400 });
  }
  if (body.action === "set_plugin_skill" && typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }

  const settingsManager = SettingsManager.create(body.cwd, agentDir, {
    projectTrusted: projectTrust.trusted,
  });
  if (
    body.action === "set_plugin_skill"
    && body.enabled === true
    && isDisabledPluginPackage(settingsManager, body.cwd, agentDir, source, targetScope)
  ) {
    return NextResponse.json(
      { error: "Enable the parent plugin before enabling its skills", pluginDisabled: true },
      { status: 409 },
    );
  }
  const state = body.enabled ? "enabled" : "disabled";
  if (targetScope === "project") {
    if (body.action === "set_plugin_skill") {
      setProjectPackageResourceOverride(settingsManager, source, "skills", resourceKey, state);
    } else {
      clearProjectPackageResourceOverride(settingsManager, source, "skills", resourceKey);
    }
  } else if (body.action === "set_plugin_skill") {
    setGlobalPluginSkillFilter(settingsManager, source, resourceKey, state);
  } else {
    clearGlobalPluginSkillFilter(settingsManager, source, resourceKey);
  }
  await flushSkillSettings(settingsManager);
  return NextResponse.json(await loadSkillsWithInstallInfo(body.cwd, viewScope));
}

async function flushSkillSettings(settingsManager: SettingsManager): Promise<void> {
  const loadErrors = settingsManager.drainErrors();
  if (loadErrors.length) throw loadErrors[0].error;
  await settingsManager.flush();
  const writeErrors = settingsManager.drainErrors();
  if (writeErrors.length) throw writeErrors[0].error;
}

async function patchGlobalSkillResource(body: {
  action: SkillResourceAction;
  cwd?: string;
  filePath?: string;
  enabled?: boolean;
  viewScope?: SkillViewScope;
}): Promise<NextResponse> {
  const { cwd, filePath } = body;
  if (!cwd || !filePath) return NextResponse.json({ error: "cwd and filePath required" }, { status: 400 });
  if (typeof body.enabled !== "boolean" && body.action === "set_global_skill_resource") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }
  if (!isExistingDirectory(cwd)) {
    return NextResponse.json({ error: "cwd must be an existing directory" }, { status: 400 });
  }
  if (path.basename(filePath) !== "SKILL.md") {
    return NextResponse.json({ error: "filePath must point to a SKILL.md file" }, { status: 400 });
  }
  if (!existsSync(filePath)) return NextResponse.json({ error: "file not found" }, { status: 404 });
  const agentDir = getAgentDir();
  const discovered = await loadSkillsWithInstallInfo(cwd, "global");
  const target = discovered.skills.find((skill) => path.resolve(skill.filePath) === path.resolve(filePath));
  if (!target) return NextResponse.json({ error: "Skill not found in this project" }, { status: 404 });
  if (target.sourceInfo.scope !== "user" || target.sourceInfo.origin !== "top-level") {
    return NextResponse.json({ error: "Global resource changes require a global top-level Skill" }, { status: 400 });
  }
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  if (body.action === "set_global_skill_resource") {
    setGlobalTopLevelSkillOverride(settingsManager, target.filePath, body.enabled ? "enabled" : "disabled");
  } else {
    clearGlobalTopLevelSkillOverride(settingsManager, target.filePath);
  }
  await flushSkillSettings(settingsManager);
  return NextResponse.json(await loadSkillsWithInstallInfo(cwd, body.viewScope ?? "global"));
}

async function patchSkillInvocationMode(body: {
  action: SkillInvocationModeAction;
  cwd?: string;
  filePath?: string;
  source?: string;
  resourceKey?: string;
  mode?: SkillInvocationMode;
  scope?: SkillViewScope;
  viewScope?: SkillViewScope;
}): Promise<NextResponse> {
  const { cwd } = body;
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
  if (body.action === "set_skill_invocation_mode"
    && body.mode !== "automatic" && body.mode !== "explicit-only") {
    return NextResponse.json({ error: "mode must be automatic or explicit-only" }, { status: 400 });
  }
  const targetScope = readScope(body.scope);
  const viewScope = body.viewScope ? readScope(body.viewScope) : targetScope;
  if (!isExistingDirectory(cwd)) {
    return NextResponse.json({ error: "cwd must be an existing directory" }, { status: 400 });
  }
  const agentDir = getAgentDir();
  const projectTrust = getProjectTrustStatus(cwd, agentDir);
  if (targetScope === "project" && !projectTrust.trusted) {
    return NextResponse.json(
      { error: "Project resources must be trusted before modifying project Skill invocation modes" },
      { status: 403 },
    );
  }
  const current = await loadSkillsWithInstallInfo(cwd, viewScope);
  const fileTarget = body.filePath
    ? current.skills.find((skill) => path.resolve(skill.filePath) === path.resolve(body.filePath!))
    : undefined;
  if (body.filePath && !fileTarget) {
    return NextResponse.json({ error: "Skill filePath not found in this project" }, { status: 404 });
  }
  const hasSource = body.source !== undefined;
  const hasResourceKey = body.resourceKey !== undefined;
  if (hasResourceKey && !hasSource) {
    return NextResponse.json({ error: "source is required with resourceKey" }, { status: 400 });
  }

  let target = fileTarget;
  if (hasSource && hasResourceKey) {
    const source = body.source?.trim() ?? "";
    const resourceKey = body.resourceKey?.trim().replaceAll("\\", "/") ?? "";
    if (!source || !isSafeResourceKey(resourceKey)) {
      return NextResponse.json({ error: "source and resourceKey required" }, { status: 400 });
    }
    const candidatePolicyKeys = new Set(["user", "project"].map((scope) => {
      try {
        return `package:${getPluginPackageIdentity(source, {
          cwd,
          agentDir,
          scope: scope as "user" | "project",
        })}:${resourceKey}`;
      } catch {
        return "";
      }
    }));
    const packageTarget = current.skills.find((skill) =>
      skill.sourceInfo?.origin === "package"
      && skill.pluginResourceKey === resourceKey
      && Boolean(skill.policyKey && candidatePolicyKeys.has(skill.policyKey)),
    );
    if (!packageTarget) return NextResponse.json({ error: "Skill not found in this project" }, { status: 404 });
    if (fileTarget && path.resolve(fileTarget.filePath) !== path.resolve(packageTarget.filePath)) {
      return NextResponse.json(
        { error: "filePath and package identity identify different Skills" },
        { status: 409 },
      );
    }
    target = packageTarget;
  } else if (hasSource) {
    // The SDK represents every top-level/user-path Skill with source="local"
    // and no package resource key. The exact filePath is its only identity;
    // never turn this form into a display-name or basename lookup.
    const source = body.source?.trim() ?? "";
    if (!fileTarget) return NextResponse.json({ error: "filePath required for a local Skill" }, { status: 400 });
    if (fileTarget.sourceInfo?.origin !== "top-level"
      || (source !== "local" && source !== fileTarget.sourceInfo?.source)) {
      return NextResponse.json(
        { error: "filePath and source identify different Skills" },
        { status: 409 },
      );
    }
    target = fileTarget;
  } else if (fileTarget?.sourceInfo?.origin === "package") {
    // Package Skill policy keys are stable package-identity + resource-key;
    // accepting a bare path would bypass that binding.
    return NextResponse.json(
      { error: "package Skills require source and resourceKey" },
      { status: 400 },
    );
  }
  if (!target) return NextResponse.json({ error: "Skill not found in this project" }, { status: 404 });
  if (targetScope === "global" && target.sourceInfo.scope !== "user") {
    return NextResponse.json({ error: "Global invocation modes require a global Skill" }, { status: 400 });
  }
  if (!target.policyKey) return NextResponse.json({ error: "Skill policy key unavailable" }, { status: 409 });
  const mode = body.action === "clear_skill_invocation_mode" ? null : body.mode!;
  if (targetScope === "project") {
    await setProjectSkillInvocationMode(cwd, agentDir, target.policyKey, mode);
  } else {
    await setGlobalSkillInvocationMode(agentDir, target.policyKey, mode);
  }
  return NextResponse.json(await loadSkillsWithInstallInfo(cwd, viewScope));
}

async function patchUnifiedSkillStates(body: { cwd?: string; viewScope?: SkillViewScope; state?: unknown; items?: unknown; restore?: unknown }): Promise<NextResponse> {
  const scope = readScope(body.viewScope);
  if (!body.cwd || !Array.isArray(body.items) || body.items.length === 0 || body.items.length > 300
    || !body.items.every((item) => item && typeof item.filePath === "string" && item.filePath.length <= 4096 && path.basename(item.filePath) === "SKILL.md")) {
    return NextResponse.json({ error: "cwd and 1 to 300 discovered Skill paths required" }, { status: 400 });
  }
  if ((body.state === undefined) === (body.restore === undefined)
    || (body.state !== undefined && (!["automatic", "explicit-only", "disabled", "inherit"].includes(String(body.state)) || (body.state === "inherit" && scope !== "project")))) {
    return NextResponse.json({ error: "A valid target state or restore snapshot is required" }, { status: 400 });
  }
  const paths = body.items.map((item) => path.resolve(item.filePath));
  if (new Set(paths).size !== paths.length) return NextResponse.json({ error: "Duplicate Skill paths" }, { status: 400 });
  if (!isExistingDirectory(body.cwd)) return NextResponse.json({ error: "cwd must be an existing directory" }, { status: 400 });
  const agentDir = getAgentDir();
  if (scope === "project" && !getProjectTrustStatus(body.cwd, agentDir).trusted) return NextResponse.json({ error: "Project resources must be trusted before modifying project skills" }, { status: 403 });
  const loaded = await loadSkillsWithInstallInfo(body.cwd, scope);
  const targets = paths.map((filePath) => loaded.skills.find((skill) => path.resolve(skill.filePath) === filePath));
  if (targets.some((skill) => !skill)) return NextResponse.json({ error: "Skill not found in selected scope" }, { status: 404 });
  if (targets.some((skill) => !skill?.policyKey || skill.policy?.availability !== "available")) return NextResponse.json({ error: "Skill policy is unavailable" }, { status: 409 });
  const restore = body.restore as SkillStateSnapshot[] | undefined;
  if (restore !== undefined && (!Array.isArray(restore) || restore.length !== paths.length
    || restore.some((item) => !item || typeof item.filePath !== "string" || !paths.includes(path.resolve(item.filePath))
      || !["inherit", "enabled", "disabled"].includes(item.resource)
      || (item.mode !== null && !["automatic", "explicit-only"].includes(item.mode)))
    || new Set(restore.map((item) => path.resolve(item.filePath))).size !== paths.length)) {
    return NextResponse.json({ error: "Restore snapshots must match the selected Skills" }, { status: 400 });
  }
  const changes = targets.map((target) => {
    const skill = target!;
    const previous = restore?.find((item) => path.resolve(item.filePath) === path.resolve(skill.filePath));
    return { skill, ...(previous ? { restore: { ...previous, filePath: skill.filePath } } : { state: body.state as SkillUseState | "inherit" }) };
  });
  const snapshots = await writeSkillStateSettings(body.cwd, agentDir, scope, changes);
  return NextResponse.json({ ...(await loadSkillsWithInstallInfo(body.cwd, scope)), snapshots, results: targets.map((skill) => ({ filePath: skill!.filePath })) });
}

export const dynamic = "force-dynamic";

// Uses DefaultPackageManager (same package/resource resolution as AgentSession startup)
// so package skills and top-level skills are returned with their enabled state.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });

  try {
    if (!isExistingDirectory(cwd)) {
      return NextResponse.json({ error: "cwd must be an existing directory" }, { status: 400 });
    }
    const viewScope = searchParams.has("scope") ? readScope(searchParams.get("scope")) : "project";
    return NextResponse.json(await loadSkillsWithInstallInfo(cwd, viewScope));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

interface SkillSettingsEdit {
      action?: PluginSkillAction | GlobalSkillInvocationAction | SkillResourceAction | ProjectResourceAction | SkillInvocationModeAction;
      cwd?: string;
      source?: string;
      resourceKey?: string;
      enabled?: boolean;
      mode?: SkillInvocationMode;
      state?: SkillUseState | "inherit";
      scope?: SkillViewScope;
      viewScope?: SkillViewScope;
      filePath?: string;
}

async function patchSkillSettings(body: SkillSettingsEdit): Promise<NextResponse> {

  if (body.action === "set_plugin_skill" || body.action === "clear_plugin_skill") {
      return patchPluginSkill({
        action: body.action,
        cwd: body.cwd,
        filePath: body.filePath,
        source: body.source,
        resourceKey: body.resourceKey,
        enabled: body.enabled,
        scope: body.scope,
        viewScope: body.viewScope,
      });
    }
    if (body.action === "set_skill_invocation_mode" || body.action === "clear_skill_invocation_mode") {
      return patchSkillInvocationMode({
        action: body.action,
        cwd: body.cwd,
        filePath: body.filePath,
        source: body.source,
        resourceKey: body.resourceKey,
        mode: body.mode,
        scope: body.scope,
        viewScope: body.viewScope,
      });
    }
    if (body.action === "set_global_skill_resource" || body.action === "clear_global_skill_resource") {
      return patchGlobalSkillResource({
        action: body.action,
        cwd: body.cwd,
        filePath: body.filePath,
        enabled: body.enabled,
        viewScope: body.viewScope,
      });
    }
    if (body.action === "set_global_skill_invocation") {
      const { cwd, filePath, enabled } = body;
      if (!cwd || !filePath) {
        return NextResponse.json({ error: "cwd and filePath required" }, { status: 400 });
      }
      if (typeof enabled !== "boolean") {
        return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
      }
      if (!isExistingDirectory(cwd)) {
        return NextResponse.json({ error: "cwd must be an existing directory" }, { status: 400 });
      }
      if (path.basename(filePath) !== "SKILL.md") {
        return NextResponse.json({ error: "filePath must point to a SKILL.md file" }, { status: 400 });
      }
      if (!existsSync(filePath)) return NextResponse.json({ error: "file not found" }, { status: 404 });
      const agentDir = getAgentDir();
      const discovered = await loadSkillsWithInstallInfo(cwd, "global");
      const target = discovered.skills.find((skill) => path.resolve(skill.filePath) === path.resolve(filePath));
      if (!target) return NextResponse.json({ error: "Skill not found in this project" }, { status: 404 });
      if (target.sourceInfo.scope !== "user" || target.sourceInfo.origin !== "top-level") {
        return NextResponse.json({ error: "Global invocation overrides require a global top-level Skill" }, { status: 400 });
      }
      await setGlobalSkillInvocationOverride(agentDir, target.filePath, enabled ? "enabled" : "disabled");
      return NextResponse.json(await loadSkillsWithInstallInfo(cwd, "global"));
    }
    const { filePath } = body;
    if ((body.action === "set_project_resource" || body.action === "clear_project_resource")) {
      if (!body.cwd || !filePath) {
        return NextResponse.json({ error: "cwd and filePath required" }, { status: 400 });
      }
      if (!isExistingDirectory(body.cwd)) {
        return NextResponse.json({ error: "cwd must be an existing directory" }, { status: 400 });
      }
      if (!existsSync(filePath)) return NextResponse.json({ error: "file not found" }, { status: 404 });
      const agentDir = getAgentDir();
      const projectTrust = getProjectTrustStatus(body.cwd, agentDir);
      if (!projectTrust.trusted) {
        return NextResponse.json(
          { error: "Project resources must be trusted before modifying project skills" },
          { status: 403 },
        );
      }
      const settingsManager = SettingsManager.create(body.cwd, agentDir, {
        projectTrusted: true,
      });
      if (body.action === "set_project_resource") {
        if (typeof body.enabled !== "boolean") {
          return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
        }
        setProjectTopLevelOverride(
          settingsManager,
          body.cwd,
          "skills",
          filePath,
          body.enabled ? "enabled" : "disabled",
        );
      } else {
        clearProjectTopLevelOverride(settingsManager, body.cwd, "skills", filePath);
      }
      await flushSkillSettings(settingsManager);
      return NextResponse.json(await loadSkillsWithInstallInfo(body.cwd, body.viewScope ?? "project"));
    }
    return NextResponse.json({ error: "Unsupported Skill action" }, { status: 400 });
}

// Single and grouped use-state edits share one resource/mode transaction.
export async function PATCH(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const body = await req.json() as Omit<SkillSettingsEdit, "action"> & { action?: SkillSettingsEdit["action"] | "set_skill_group"; items?: unknown; restore?: unknown };
    if (body.action !== "set_skill_group") return await patchSkillSettings({ ...body, action: body.action });
    return await patchUnifiedSkillStates(body);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
