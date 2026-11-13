import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { NextRequest, NextResponse } from "next/server";
import { extractAssistantText } from "@/lib/question-analysis";
import { isWindowsAbsolutePath } from "@/lib/paths";
import { getGitFileDiff, getGitHistory, getGitStatus } from "@/lib/git-changes";
import {
  buildGitAiInput,
  buildGitAiSystemPrompt,
  buildGitReleaseInput,
  buildGitAiUserPrompt,
  GIT_AI_MAX_FILES,
  GIT_AI_MAX_OUTPUT_CHARS,
  type GitAiLocale,
  type GitAiMode,
  type GitDiffFragment,
} from "@/lib/git-summary";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { projectTrustReloadOptions } from "@/lib/project-trust";
import { resolveVisibleModels, selectInitialModelScope } from "@/lib/model-scope";
import { createReaderAgentSessionServices } from "@/lib/model-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const GIT_AI_TIMEOUT_MS = 90_000;
const GIT_AI_SUMMARY_MAX_TOKENS = 700;
const GIT_AI_COMMIT_MAX_TOKENS = 180;

type SimpleCompletionRuntime = {
  completeSimple: (
    model: unknown,
    context: {
      systemPrompt: string;
      messages: Array<{ role: "user"; content: string; timestamp: number }>;
    },
    options: { maxTokens: number; maxRetries: number; timeoutMs: number },
  ) => Promise<{
    stopReason?: string;
    errorMessage?: string;
    content?: unknown;
    usage?: { input?: unknown; output?: unknown; totalTokens?: unknown };
  }>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseMode(value: unknown): GitAiMode | null {
  return value === "summary" || value === "commit-message" || value === "release-notes" ? value : null;
}

function parseLocale(value: unknown): GitAiLocale {
  return value === "en" ? "en" : "zh-CN";
}

function relativeGitPath(repositoryRoot: string, filePath: string): string {
  const relative = path.relative(repositoryRoot, filePath).split(path.sep).join("/");
  return relative || path.basename(filePath);
}

async function collectGitInput(cwd: string): Promise<{ input: string; truncated: boolean; fileCount: number }> {
  const status = await getGitStatus(cwd);
  if (!status.isGitRepository) {
    throw new Error("not_git_repository");
  }
  if (status.files.length === 0) {
    throw new Error("no_changes");
  }

  const repositoryRoot = status.repositoryRoot ?? cwd;
  const selectedFiles = status.files.slice(0, GIT_AI_MAX_FILES);
  const fragments = await Promise.all(selectedFiles.map(async (file): Promise<GitDiffFragment> => {
    const diff = await getGitFileDiff(cwd, file.filePath);
    return {
      relativePath: relativeGitPath(repositoryRoot, file.filePath),
      status: `${file.code} ${file.status}`,
      ...(diff.supported && diff.patch ? { patch: diff.patch } : {}),
    };
  }));
  const input = buildGitAiInput(status, fragments, status.files.length - selectedFiles.length);
  return { input: input.text, truncated: input.truncated || selectedFiles.length < status.files.length, fileCount: status.files.length };
}

async function collectGitReleaseInput(cwd: string): Promise<{ input: string; truncated: boolean; fileCount: number; historyCount: number }> {
  const status = await getGitStatus(cwd);
  if (!status.isGitRepository) throw new Error("not_git_repository");
  const history = await getGitHistory(cwd, 20) ?? [];
  let worktreeInput = "[working tree clean]";
  let truncated = false;
  if (status.files.length > 0) {
    const snapshot = await collectGitInput(cwd);
    worktreeInput = snapshot.input;
    truncated = snapshot.truncated;
  }
  const releaseInput = buildGitReleaseInput(history, worktreeInput);
  return {
    input: releaseInput.text,
    truncated: truncated || releaseInput.truncated,
    fileCount: status.files.length,
    historyCount: history.length,
  };
}

async function resolveSummaryModel(cwd: string) {
  const agentDir = getAgentDir();
  const trustReloadOptions = projectTrustReloadOptions(cwd, agentDir);
  const services = await createReaderAgentSessionServices({
    cwd,
    agentDir,
    ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
  });
  const scope = await resolveVisibleModels(services.modelRuntime, services.settingsManager.getEnabledModels());
  const defaultProvider = services.settingsManager.getDefaultProvider();
  const defaultModel = services.settingsManager.getDefaultModel();
  const selected = selectInitialModelScope(scope, {
    ...(defaultProvider && defaultModel ? { defaultModel: { provider: defaultProvider, modelId: defaultModel } } : {}),
  });
  if (!selected.model) throw new Error("No model is configured for Git summary");
  return { runtime: services.modelRuntime as unknown as SimpleCompletionRuntime, model: selected.model };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await request.json() as { cwd?: unknown; mode?: unknown; locale?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    const mode = parseMode(body.mode);
    const locale = parseLocale(body.locale);
    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
    }
    if (!mode) return NextResponse.json({ error: "mode must be summary, commit-message, or release-notes" }, { status: 400 });

    let stat: fs.Stats;
    try {
      stat = fs.statSync(cwd);
    } catch {
      return NextResponse.json({ error: "Directory not found" }, { status: 404 });
    }
    if (!stat.isDirectory()) return NextResponse.json({ error: "Not a directory" }, { status: 400 });

    const snapshot = mode === "release-notes"
      ? await collectGitReleaseInput(cwd)
      : await collectGitInput(cwd);
    const { runtime, model } = await resolveSummaryModel(cwd);
    const response = await runtime.completeSimple(model, {
      systemPrompt: buildGitAiSystemPrompt(mode, locale),
      messages: [{
        role: "user",
        content: buildGitAiUserPrompt(snapshot.input, mode),
        timestamp: Date.now(),
      }],
    }, {
      maxTokens: mode === "commit-message" ? GIT_AI_COMMIT_MAX_TOKENS : GIT_AI_SUMMARY_MAX_TOKENS,
      maxRetries: 1,
      timeoutMs: GIT_AI_TIMEOUT_MS,
    });
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      return NextResponse.json({ error: response.errorMessage || "Git AI request failed" }, { status: 502 });
    }
    const text = extractAssistantText(response.content).slice(0, GIT_AI_MAX_OUTPUT_CHARS).trim();
    if (!text) return NextResponse.json({ error: "Git AI returned no text" }, { status: 502 });

    return NextResponse.json({
      mode,
      text,
      truncated: snapshot.truncated,
      fileCount: snapshot.fileCount,
      ...(mode === "release-notes" && "historyCount" in snapshot ? { historyCount: snapshot.historyCount } : {}),
      model: { provider: model.provider, modelId: model.id },
      ...(response.usage ? {
        usage: {
          input: numberValue(response.usage.input),
          output: numberValue(response.usage.output),
          totalTokens: numberValue(response.usage.totalTokens),
        },
      } : {}),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = errorMessage(error);
    if (message === "not_git_repository") return NextResponse.json({ error: "This folder is not a Git repository" }, { status: 409 });
    if (message === "no_changes") return NextResponse.json({ error: "No Git changes to summarize" }, { status: 409 });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
