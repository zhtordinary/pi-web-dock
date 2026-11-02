import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SkillInfo, SkillViewScope } from "@/lib/api-types";
import type { SkillTriggerAnalysisStats } from "@/lib/skill-trigger-analysis";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { getProjectTrustStatus } from "@/lib/project-trust";
import { refreshUpdatedSkillTriggerMetadata } from "@/lib/skill-trigger-analysis";
import { loadSkillsWithInstallInfo } from "@/lib/skills-service";

export class SkillAnalysisRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SkillAnalysisRequestError";
  }
}

export function readSkillAnalysisScope(scope: unknown): SkillViewScope {
  return scope === "project" ? "project" : "global";
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new SkillAnalysisRequestError(`${field} is required`, 400);
  }
  return value;
}

export async function validateSkillAnalysisScope(
  cwdInput: unknown,
  scope: SkillViewScope,
): Promise<{ cwd: string; agentDir: string }> {
  const cwd = requireText(cwdInput, "cwd");
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    throw new SkillAnalysisRequestError("Access denied", 403);
  }

  const agentDir = getAgentDir();
  if (scope === "project" && !getProjectTrustStatus(cwd, agentDir).trusted) {
    throw new SkillAnalysisRequestError(
      "Project resources must be trusted before analyzing project skills",
      403,
    );
  }
  return { cwd, agentDir };
}

export async function loadRequestedSkill(
  cwdInput: unknown,
  scope: SkillViewScope,
  filePathInput: unknown,
): Promise<{ cwd: string; agentDir: string; skill: SkillInfo }> {
  const { cwd, agentDir } = await validateSkillAnalysisScope(cwdInput, scope);
  const filePath = requireText(filePathInput, "filePath");
  const loaded = await loadSkillsWithInstallInfo(cwd, scope);
  const skill = loaded.skills.find((item) => item.filePath === filePath);
  if (!skill) {
    throw new SkillAnalysisRequestError("Skill not found in selected scope", 404);
  }
  return { cwd, agentDir, skill };
}

export async function validateSkillAnalysisTargets(
  cwdInput: unknown,
  scope: SkillViewScope,
  filePathsInput: unknown,
): Promise<string[]> {
  if (!Array.isArray(filePathsInput) || filePathsInput.length === 0 || filePathsInput.length > 256) {
    throw new SkillAnalysisRequestError("filePaths must contain 1 to 256 skills", 400);
  }
  const filePaths = [...new Set(filePathsInput.map((filePath) => {
    if (typeof filePath !== "string" || !filePath.trim() || filePath.length > 4096) {
      throw new SkillAnalysisRequestError("filePaths contains an invalid path", 400);
    }
    return filePath;
  }))];
  const { cwd } = await validateSkillAnalysisScope(cwdInput, scope);
  const loaded = await loadSkillsWithInstallInfo(cwd, scope);
  const loadedPaths = new Set(loaded.skills.map((skill) => skill.filePath));
  if (filePaths.some((filePath) => !loadedPaths.has(filePath))) {
    throw new SkillAnalysisRequestError("Skill not found in selected scope", 404);
  }
  return filePaths;
}

export async function analyzeRequestedSkill(
  cwdInput: unknown,
  scope: SkillViewScope,
  filePathInput: unknown,
): Promise<{ skill?: SkillInfo; triggerModes: SkillTriggerAnalysisStats }> {
  const { cwd, agentDir, skill } = await loadRequestedSkill(cwdInput, scope, filePathInput);
  const triggerModes = await refreshUpdatedSkillTriggerMetadata([skill], { cwd, agentDir });
  const refreshed = await loadSkillsWithInstallInfo(cwd, scope);
  return {
    skill: refreshed.skills.find((item) => item.filePath === skill.filePath),
    triggerModes,
  };
}
