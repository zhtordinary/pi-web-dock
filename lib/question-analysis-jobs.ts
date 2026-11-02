import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "./types";
import type { QuestionAnalysisContextSource, QuestionAnalysisMode, QuestionAnalysisResult, QuestionRewriteResult } from "./question-analysis";

/** Persisted through Pi custom entries; skipped by buildSessionContext(). */
export const QUESTION_ANALYSIS_CUSTOM_TYPE = "question-terminology";
/** Draft question work (analysis/rewrite) captured for a prompt that has not been persisted yet. */
export const QUESTION_DRAFT_CUSTOM_TYPE = "question-draft";
export const QUESTION_ANALYSIS_JOB_VERSION = 1;
export const QUESTION_DRAFT_VERSION = 1;

export type QuestionAnalysisJobStatus = "pending" | "running" | "completed" | "failed";

export interface QuestionAnalysisJobContext {
  source: QuestionAnalysisContextSource;
  summaryChars: number;
  recentChars: number;
  recentMessages: number;
}

export interface QuestionAnalysisJobModel {
  provider: string;
  modelId: string;
}

export interface QuestionAnalysisJob {
  jobId: string;
  targetEntryId: string;
  status: QuestionAnalysisJobStatus;
  question: string;
  mode: QuestionAnalysisMode;
  model: QuestionAnalysisJobModel;
  priorContext: string;
  context: QuestionAnalysisJobContext;
  requestedAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: QuestionAnalysisResult;
  error?: string;
}

/** Safe browser-facing projection. Input/context snapshots stay in JSONL only. */
export interface QuestionAnalysisJobView {
  jobId: string;
  targetEntryId: string;
  status: QuestionAnalysisJobStatus;
  mode: QuestionAnalysisMode;
  requestedAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: QuestionAnalysisResult;
  error?: string;
}

/** Browser-facing projection of an attached draft result. */
export interface QuestionDraftView {
  version: typeof QUESTION_DRAFT_VERSION;
  jobId: string;
  targetEntryId: string;
  requestedAt: number;
  result: QuestionAnalysisResult;
  rewrite?: QuestionRewriteResult;
}

/** Durable draft snapshot appended when its prompt is sent. */
export interface QuestionDraftEntryData {
  version: typeof QUESTION_DRAFT_VERSION;
  jobId: string;
  targetEntryId: string;
  requestedAt: number;
  result: QuestionAnalysisResult;
  rewrite?: QuestionRewriteResult;
}

export type QuestionAnalysisJobEntryData =
  | {
      version: typeof QUESTION_ANALYSIS_JOB_VERSION;
      jobId: string;
      targetEntryId: string;
      status: "pending";
      question: string;
      mode: QuestionAnalysisMode;
      model: QuestionAnalysisJobModel;
      priorContext: string;
      context: QuestionAnalysisJobContext;
      requestedAt: number;
    }
  | {
      version: typeof QUESTION_ANALYSIS_JOB_VERSION;
      jobId: string;
      targetEntryId: string;
      status: "running";
      startedAt: number;
    }
  | {
      version: typeof QUESTION_ANALYSIS_JOB_VERSION;
      jobId: string;
      targetEntryId: string;
      status: "completed";
      completedAt: number;
      result: QuestionAnalysisResult;
    }
  | {
      version: typeof QUESTION_ANALYSIS_JOB_VERSION;
      jobId: string;
      targetEntryId: string;
      status: "failed";
      completedAt: number;
      error: string;
    };

function parseDraftResult(value: unknown): QuestionAnalysisResult | undefined {
  if (!isRecord(value) || !nonEmptyString(value.text)) return undefined;
  return value as unknown as QuestionAnalysisResult;
}

function parseRewriteResult(value: unknown): QuestionRewriteResult | undefined {
  if (!isRecord(value) || !nonEmptyString(value.text)) return undefined;
  return value as unknown as QuestionRewriteResult;
}

function parseQuestionDraftData(value: unknown): QuestionDraftEntryData | null {
  if (!isRecord(value) || value.version !== QUESTION_DRAFT_VERSION) return null;
  if (!nonEmptyString(value.jobId) || !nonEmptyString(value.targetEntryId)) return null;
  if (!finiteNumber(value.requestedAt)) return null;
  const result = parseDraftResult(value.result);
  if (!result) return null;
  const rewriteValue = value.rewrite;
  const rewrite = rewriteValue === undefined ? undefined : parseRewriteResult(rewriteValue);
  if (rewriteValue !== undefined && !rewrite) return null;
  return {
    version: QUESTION_DRAFT_VERSION,
    jobId: value.jobId,
    targetEntryId: value.targetEntryId,
    requestedAt: value.requestedAt,
    result,
    ...(rewrite ? { rewrite } : {}),
  };
}

/** Read durable draft snapshots for the selected entries (any branch). */
export function readQuestionDrafts(entries: SessionEntry[]): QuestionDraftEntryData[] {
  const drafts: QuestionDraftEntryData[] = [];
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== QUESTION_DRAFT_CUSTOM_TYPE) continue;
    const draft = parseQuestionDraftData(entry.data);
    if (draft) drafts.push(draft);
  }
  return drafts.sort((a, b) => a.requestedAt - b.requestedAt);
}

/** Latest draft snapshot per target user entry. */
export function latestQuestionDrafts(
  entries: SessionEntry[],
  targetEntryIds?: ReadonlySet<string>,
): QuestionDraftEntryData[] {
  const latest = new Map<string, QuestionDraftEntryData>();
  for (const draft of readQuestionDrafts(entries)) {
    if (targetEntryIds && !targetEntryIds.has(draft.targetEntryId)) continue;
    const previous = latest.get(draft.targetEntryId);
    if (!previous || draft.requestedAt >= previous.requestedAt) latest.set(draft.targetEntryId, draft);
  }
  return [...latest.values()].sort((a, b) => a.requestedAt - b.requestedAt);
}

const DEFAULT_CONTEXT: QuestionAnalysisJobContext = {
  source: "none",
  summaryChars: 0,
  recentChars: 0,
  recentMessages: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseMode(value: unknown): QuestionAnalysisMode | null {
  return value === "question" || value === "context" ? value : null;
}

function parseContext(value: unknown): QuestionAnalysisJobContext {
  if (!isRecord(value)) return { ...DEFAULT_CONTEXT };
  const source = value.source;
  return {
    source: source === "existing-summary"
      || source === "recent-context"
      || source === "existing-summary+recent-context"
      || source === "unavailable"
      ? source
      : "none",
    summaryChars: finiteNumber(value.summaryChars) ? value.summaryChars : 0,
    recentChars: finiteNumber(value.recentChars) ? value.recentChars : 0,
    recentMessages: finiteNumber(value.recentMessages) ? value.recentMessages : 0,
  };
}

function parseModel(value: unknown): QuestionAnalysisJobModel | null {
  if (!isRecord(value) || !nonEmptyString(value.provider) || !nonEmptyString(value.modelId)) return null;
  return { provider: value.provider, modelId: value.modelId };
}

function parseResult(value: unknown): QuestionAnalysisResult | undefined {
  if (!isRecord(value) || !nonEmptyString(value.text)) return undefined;
  return value as unknown as QuestionAnalysisResult;
}

function parseEntryData(value: unknown): QuestionAnalysisJobEntryData | null {
  if (!isRecord(value) || value.version !== QUESTION_ANALYSIS_JOB_VERSION) return null;
  if (!nonEmptyString(value.jobId) || !nonEmptyString(value.targetEntryId)) return null;
  if (value.status === "pending") {
    const mode = parseMode(value.mode);
    const model = parseModel(value.model);
    const priorContext = value.priorContext;
    if (
      !mode
      || !nonEmptyString(value.question)
      || !model
      || typeof priorContext !== "string"
      || !finiteNumber(value.requestedAt)
    ) return null;
    return {
      version: QUESTION_ANALYSIS_JOB_VERSION,
      jobId: value.jobId,
      targetEntryId: value.targetEntryId,
      status: "pending",
      question: value.question,
      mode,
      model,
      priorContext,
      context: parseContext(value.context),
      requestedAt: value.requestedAt,
    };
  }
  if (value.status === "running" && finiteNumber(value.startedAt)) {
    return {
      version: QUESTION_ANALYSIS_JOB_VERSION,
      jobId: value.jobId,
      targetEntryId: value.targetEntryId,
      status: "running",
      startedAt: value.startedAt,
    };
  }
  if (value.status === "completed" && finiteNumber(value.completedAt)) {
    const result = parseResult(value.result);
    if (!result) return null;
    return {
      version: QUESTION_ANALYSIS_JOB_VERSION,
      jobId: value.jobId,
      targetEntryId: value.targetEntryId,
      status: "completed",
      completedAt: value.completedAt,
      result,
    };
  }
  if (value.status === "failed" && finiteNumber(value.completedAt) && typeof value.error === "string") {
    return {
      version: QUESTION_ANALYSIS_JOB_VERSION,
      jobId: value.jobId,
      targetEntryId: value.targetEntryId,
      status: "failed",
      completedAt: value.completedAt,
      error: value.error,
    };
  }
  return null;
}

type MergedJob = { job: QuestionAnalysisJob; order: number };

/** Merge append-only state entries into one durable job record per job id. */
export function readQuestionAnalysisJobs(entries: SessionEntry[]): QuestionAnalysisJob[] {
  const merged = new Map<string, MergedJob>();
  entries.forEach((entry, order) => {
    if (entry.type !== "custom" || entry.customType !== QUESTION_ANALYSIS_CUSTOM_TYPE) return;
    const data = parseEntryData(entry.data);
    if (!data) return;
    const previous = merged.get(data.jobId);
    if (data.status === "pending") {
      merged.set(data.jobId, {
        order,
        job: {
          jobId: data.jobId,
          targetEntryId: data.targetEntryId,
          status: "pending",
          question: data.question,
          mode: data.mode,
          model: data.model,
          priorContext: data.priorContext,
          context: data.context,
          requestedAt: data.requestedAt,
        },
      });
      return;
    }
    if (!previous) return;
    const job = previous.job;
    if (data.status === "running") {
      merged.set(data.jobId, { order, job: { ...job, status: "running", startedAt: data.startedAt } });
    } else if (data.status === "completed") {
      merged.set(data.jobId, { order, job: { ...job, status: "completed", completedAt: data.completedAt, result: data.result, error: undefined } });
    } else {
      merged.set(data.jobId, { order, job: { ...job, status: "failed", completedAt: data.completedAt, error: data.error, result: undefined } });
    }
  });
  return [...merged.values()]
    .sort((a, b) => a.order - b.order)
    .map(({ job }) => job);
}

/** Select latest job for each target user entry, optionally limited to active branch targets. */
export function latestQuestionAnalysisJobs(
  entries: SessionEntry[],
  targetEntryIds?: ReadonlySet<string>,
): QuestionAnalysisJob[] {
  const latest = new Map<string, QuestionAnalysisJob>();
  for (const job of readQuestionAnalysisJobs(entries)) {
    if (targetEntryIds && !targetEntryIds.has(job.targetEntryId)) continue;
    const previous = latest.get(job.targetEntryId);
    if (!previous || job.requestedAt >= previous.requestedAt) latest.set(job.targetEntryId, job);
  }
  return [...latest.values()].sort((a, b) => a.requestedAt - b.requestedAt);
}

/** Deterministic job id for one draft analysis result (no RPC wrapper needed). */
export function draftAnalysisJobId(cwd: string, message: string): string {
  return `draft-${createHash("sha256").update(`${cwd}\0${message}`).digest("hex").slice(0, 24)}`;
}

/** Map stored draft snapshots onto the same { targetEntryId -> view } shape as question jobs. */
export function draftViewByTarget(
  entries: SessionEntry[],
  targetEntryIds?: ReadonlySet<string>,
): Map<string, QuestionDraftView> {
  const byTarget = new Map<string, QuestionDraftView>();
  for (const draft of latestQuestionDrafts(entries, targetEntryIds)) {
    byTarget.set(draft.targetEntryId, toQuestionDraftView(draft));
  }
  return byTarget;
}

export function toQuestionDraftView(draft: QuestionDraftEntryData): QuestionDraftView {
  return {
    version: draft.version,
    jobId: draft.jobId,
    targetEntryId: draft.targetEntryId,
    requestedAt: draft.requestedAt,
    result: draft.result,
    ...(draft.rewrite ? { rewrite: draft.rewrite } : {}),
  };
}

export function toQuestionAnalysisJobView(job: QuestionAnalysisJob): QuestionAnalysisJobView {
  return {
    jobId: job.jobId,
    targetEntryId: job.targetEntryId,
    status: job.status,
    mode: job.mode,
    requestedAt: job.requestedAt,
    ...(job.startedAt !== undefined ? { startedAt: job.startedAt } : {}),
    ...(job.completedAt !== undefined ? { completedAt: job.completedAt } : {}),
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

/** Append snapshot serializer used by the RPC layer when a draft prompt is sent. */
export function draftQuestionAnalysisData(draft: QuestionDraftEntryData): QuestionDraftEntryData {
  return {
    version: QUESTION_DRAFT_VERSION,
    jobId: draft.jobId,
    targetEntryId: draft.targetEntryId,
    requestedAt: draft.requestedAt,
    result: draft.result,
    ...(draft.rewrite ? { rewrite: draft.rewrite } : {}),
  };
}

export function pendingQuestionAnalysisData(job: QuestionAnalysisJob): QuestionAnalysisJobEntryData {
  return {
    version: QUESTION_ANALYSIS_JOB_VERSION,
    jobId: job.jobId,
    targetEntryId: job.targetEntryId,
    status: "pending",
    question: job.question,
    mode: job.mode,
    model: job.model,
    priorContext: job.priorContext,
    context: job.context,
    requestedAt: job.requestedAt,
  };
}

export function runningQuestionAnalysisData(job: QuestionAnalysisJob, startedAt: number): QuestionAnalysisJobEntryData {
  return {
    version: QUESTION_ANALYSIS_JOB_VERSION,
    jobId: job.jobId,
    targetEntryId: job.targetEntryId,
    status: "running",
    startedAt,
  };
}

export function completedQuestionAnalysisData(job: QuestionAnalysisJob, completedAt: number, result: QuestionAnalysisResult): QuestionAnalysisJobEntryData {
  return {
    version: QUESTION_ANALYSIS_JOB_VERSION,
    jobId: job.jobId,
    targetEntryId: job.targetEntryId,
    status: "completed",
    completedAt,
    result,
  };
}

export function failedQuestionAnalysisData(job: QuestionAnalysisJob, completedAt: number, error: string): QuestionAnalysisJobEntryData {
  return {
    version: QUESTION_ANALYSIS_JOB_VERSION,
    jobId: job.jobId,
    targetEntryId: job.targetEntryId,
    status: "failed",
    completedAt,
    error: error.slice(0, 500),
  };
}

export function isResumableQuestionAnalysisJob(job: QuestionAnalysisJob): boolean {
  // A running job may already have received a provider response before process loss.
  // Auto-resume only pre-provider pending work; explicit user retry remains available.
  return job.status === "pending"
    && nonEmptyString(job.question)
    && nonEmptyString(job.model.provider)
    && nonEmptyString(job.model.modelId);
}

const JOB_LOCK_STALE_MS = 15 * 60 * 1000;

function lockPath(sessionFile: string, jobId: string): string {
  const key = createHash("sha256").update(`${sessionFile}\0${jobId}`).digest("hex").slice(0, 32);
  return join(getAgentDir(), "question-analysis-locks", `${key}.lock`);
}

/** Cross-process claim; JSONL is shared by 30141/30142, so only one worker may spend tokens. */
export function acquireQuestionAnalysisJobLock(sessionFile: string, jobId: string): (() => void) | null {
  const path = lockPath(sessionFile, jobId);
  mkdirSync(join(getAgentDir(), "question-analysis-locks"), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(path);
      const token = randomUUID();
      writeFileSync(join(path, "owner"), token, { encoding: "utf8", flag: "wx" });
      return () => {
        try {
          if (readFileSync(join(path, "owner"), "utf8") === token) rmSync(path, { recursive: true, force: true });
        } catch {
          // Another process may have reclaimed a stale lock.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
      try {
        if (Date.now() - statSync(path).mtimeMs > JOB_LOCK_STALE_MS) {
          rmSync(path, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Race with the owner creating/removing the lock; leave it alone.
      }
      return null;
    }
  }
  return null;
}
