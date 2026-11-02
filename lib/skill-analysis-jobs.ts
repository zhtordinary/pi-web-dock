import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { SkillAnalysisFailure, SkillAnalysisJob, SkillViewScope } from "@/lib/api-types";
import { analyzeRequestedSkill, validateSkillAnalysisTargets } from "@/lib/skill-analysis-service";

const STORE_DIR_NAME = "skill-analysis-jobs";
const MAX_ERROR_CHARS = 240;

type SkillAnalysisRuntime = {
  workers: Set<string>;
};

declare global {
  var __piSkillAnalysisRuntime: SkillAnalysisRuntime | undefined;
}

function runtime(): SkillAnalysisRuntime {
  if (!globalThis.__piSkillAnalysisRuntime) {
    globalThis.__piSkillAnalysisRuntime = { workers: new Set() };
  }
  return globalThis.__piSkillAnalysisRuntime;
}

function jobKey(cwd: string, scope: SkillViewScope): string {
  return createHash("sha256").update(`${scope}\0${cwd}`, "utf8").digest("hex").slice(0, 32);
}

function jobPath(agentDir: string, cwd: string, scope: SkillViewScope): string {
  return join(agentDir, STORE_DIR_NAME, `${jobKey(cwd, scope)}.json`);
}

function readJob(agentDir: string, cwd: string, scope: SkillViewScope): SkillAnalysisJob | null {
  try {
    const parsed = JSON.parse(readFileSync(jobPath(agentDir, cwd, scope), "utf8")) as SkillAnalysisJob;
    if (
      parsed?.cwd !== cwd
      || parsed?.scope !== scope
      || typeof parsed.id !== "string"
      || !Array.isArray(parsed.targets)
      || typeof parsed.total !== "number"
      || typeof parsed.completed !== "number"
      || typeof parsed.failed !== "number"
      || typeof parsed.nextIndex !== "number"
      || !["running", "completed", "failed"].includes(parsed.status)
      || (parsed.failures !== undefined && (!Array.isArray(parsed.failures)
        || parsed.failures.length > parsed.targets.length
        || parsed.failures.some((failure) => !failure || !parsed.targets.includes(failure.filePath)
          || typeof failure.name !== "string" || typeof failure.reason !== "string")))
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeJob(agentDir: string, job: SkillAnalysisJob): void {
  const directory = join(agentDir, STORE_DIR_NAME);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = jobPath(agentDir, job.cwd, job.scope);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(job, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, target);
}

function now(): string {
  return new Date().toISOString();
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, MAX_ERROR_CHARS) || "Skill analysis failed";
}

function ensureWorker(job: SkillAnalysisJob, agentDir: string): void {
  if (job.status !== "running") return;
  const key = jobPath(agentDir, job.cwd, job.scope);
  const workers = runtime().workers;
  if (workers.has(key)) return;
  workers.add(key);
  void runWorker(job, agentDir).finally(() => workers.delete(key));
}

async function runWorker(initial: SkillAnalysisJob, agentDir: string): Promise<void> {
  let job = initial;
  try {
    for (let index = job.nextIndex; index < job.total; index += 1) {
      const current = readJob(agentDir, job.cwd, job.scope);
      if (!current || current.status !== "running" || current.id !== job.id) return;
      job = current;

      let failed = 0;
      let failure: SkillAnalysisFailure | undefined;
      try {
        const result = await analyzeRequestedSkill(job.cwd, job.scope, job.targets[index]);
        failed = result.triggerModes.failed > 0 ? 1 : 0;
        if (failed) {
          const detail = result.triggerModes.failures?.find((item) => item.filePath === job.targets[index]);
          failure = {
            filePath: job.targets[index],
            name: detail?.name || result.skill?.name || basename(dirname(job.targets[index])),
            reason: errorText(detail?.reason || result.skill?.triggerModeReason || "Skill analysis failed"),
          };
        }
      } catch (caught) {
        failed = 1;
        failure = { filePath: job.targets[index], name: basename(dirname(job.targets[index])), reason: errorText(caught) };
      }

      const latest = readJob(agentDir, job.cwd, job.scope);
      if (!latest || latest.id !== job.id || latest.status !== "running" || latest.nextIndex !== index) return;
      job = latest;
      job = {
        ...job,
        completed: job.completed + 1,
        failed: job.failed + failed,
        nextIndex: index + 1,
        updatedAt: now(),
        ...(failure ? { failures: [...(job.failures ?? []), failure] } : {}),
      };
      writeJob(agentDir, job);
    }

    job = {
      ...job,
      status: "completed",
      updatedAt: now(),
      finishedAt: now(),
    };
    writeJob(agentDir, job);
  } catch (error) {
    const current = readJob(agentDir, job.cwd, job.scope);
    if (current?.id === job.id) {
      writeJob(agentDir, {
        ...current,
        status: "failed",
        updatedAt: now(),
        finishedAt: now(),
        error: errorText(error),
      });
    }
  }
}

export async function startSkillAnalysisJob(
  cwd: string,
  scope: SkillViewScope,
  filePaths: unknown,
): Promise<SkillAnalysisJob> {
  const targets = await validateSkillAnalysisTargets(cwd, scope, filePaths);
  const agentDir = getAgentDir();
  const existing = readJob(agentDir, cwd, scope);
  if (existing?.status === "running") {
    ensureWorker(existing, agentDir);
    return existing;
  }

  const timestamp = now();
  const job: SkillAnalysisJob = {
    id: randomUUID(),
    cwd,
    scope,
    targets,
    total: targets.length,
    completed: 0,
    failed: 0,
    nextIndex: 0,
    status: "running",
    startedAt: timestamp,
    updatedAt: timestamp,
  };
  writeJob(agentDir, job);
  ensureWorker(job, agentDir);
  return job;
}

export function getSkillAnalysisJob(
  cwd: string,
  scope: SkillViewScope,
): SkillAnalysisJob | null {
  const agentDir = getAgentDir();
  const job = readJob(agentDir, cwd, scope);
  if (job) ensureWorker(job, agentDir);
  return job;
}
