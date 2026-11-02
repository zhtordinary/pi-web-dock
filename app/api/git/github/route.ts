import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import { getGitHead, getGitRemoteUrls, getGitStatus } from "@/lib/git-changes";
import {
  createGitHubPullRequest,
  fetchGitHubRepositoryInfo,
  fetchGitHubReadOnlySnapshot,
  GitHubHttpError,
  selectGitHubRepository,
  type GitHubReadOnlySnapshot,
  type GitHubUnavailableReason,
} from "@/lib/git-github";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

function unavailable(
  repository: GitHubReadOnlySnapshot["repository"],
  branch: string | null,
  reason: GitHubUnavailableReason,
): GitHubReadOnlySnapshot {
  return {
    available: false,
    repository,
    branch,
    checkedRef: null,
    defaultBranch: null,
    pullRequests: [],
    issues: [],
    checks: [],
    warnings: [],
    reason,
  };
}

export async function GET(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const cwd = request.nextUrl.searchParams.get("cwd")?.trim() ?? "";
    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(cwd, allowedRoots) || !isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(cwd);
    } catch {
      return NextResponse.json({ error: "Directory not found" }, { status: 404 });
    }
    if (!stat.isDirectory()) return NextResponse.json({ error: "Not a directory" }, { status: 400 });

    const status = await getGitStatus(cwd);
    const remotes = await getGitRemoteUrls(cwd);
    const repository = selectGitHubRepository(remotes ?? []);
    if (!status.isGitRepository || !repository) {
      return NextResponse.json({ snapshot: unavailable(null, status.branch, "no-github-remote") }, { headers: { "Cache-Control": "no-store" } });
    }

    const token = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
    if (!token) {
      return NextResponse.json({ snapshot: unavailable(repository, status.branch, "auth-required") }, { headers: { "Cache-Control": "no-store" } });
    }

    const head = await getGitHead(cwd);
    try {
      const snapshot = await fetchGitHubReadOnlySnapshot(repository, status.branch, head, token);
      return NextResponse.json({ snapshot }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const reason: GitHubUnavailableReason = error instanceof GitHubHttpError
        ? error.rateLimited || error.status === 429
          ? "rate-limited"
          : error.status === 401 || error.status === 403
            ? "auth-failed"
            : error.status === 404
              ? "repository-not-found"
              : "request-failed"
        : "request-failed";
      return NextResponse.json({ snapshot: unavailable(repository, status.branch, reason) }, { headers: { "Cache-Control": "no-store" } });
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}


const MAX_PR_REQUEST_BYTES = 64 * 1024;
const MAX_PR_TITLE_CHARS = 256;
const MAX_PR_BODY_CHARS = 20_000;
const SAFE_REF_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

function safeRef(value: string): boolean {
  return SAFE_REF_RE.test(value);
}

function invalidWriteResponse(message: string, code: string, status = 409) {
  return NextResponse.json({ error: message, code }, { status });
}

export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_PR_REQUEST_BYTES) {
    return NextResponse.json({ error: "Pull request payload is too large" }, { status: 413 });
  }

  try {
    const body = await request.json() as { cwd?: unknown; title?: unknown; body?: unknown; base?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const description = typeof body.body === "string" ? body.body.trim() : "";
    const requestedBase = typeof body.base === "string" ? body.base.trim() : "";
    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
    }
    if (!title || title.length > MAX_PR_TITLE_CHARS || title.includes("\0")) {
      return invalidWriteResponse("Pull request title is empty or too long", "title_invalid", 400);
    }
    if (description.length > MAX_PR_BODY_CHARS || description.includes("\0")) {
      return invalidWriteResponse("Pull request body is too long", "body_invalid", 400);
    }

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(cwd, allowedRoots) || !isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(cwd);
    } catch {
      return NextResponse.json({ error: "Directory not found" }, { status: 404 });
    }
    if (!stat.isDirectory()) return NextResponse.json({ error: "Not a directory" }, { status: 400 });

    const status = await getGitStatus(cwd);
    if (!status.isGitRepository || !status.repositoryRoot) return invalidWriteResponse("This folder is not a Git repository", "not_git_repository");
    const allStatus = path.resolve(status.repositoryRoot) === path.resolve(cwd)
      ? status
      : await getGitStatus(status.repositoryRoot);
    if (allStatus.files.length > 0) return invalidWriteResponse("Working tree must be clean before creating a pull request", "dirty_worktree");
    if (!status.branch) return invalidWriteResponse("A named branch is required before creating a pull request", "branch_required");
    if (!status.upstream) return invalidWriteResponse("Push the branch and configure an upstream before creating a pull request", "upstream_required");
    if (status.ahead !== 0 || status.behind !== 0) return invalidWriteResponse("Push the branch and synchronize it before creating a pull request", "branch_not_synchronized");

    const remotes = await getGitRemoteUrls(cwd);
    const repository = selectGitHubRepository(remotes ?? []);
    if (!repository) return invalidWriteResponse("No GitHub remote is configured", "no_github_remote");
    const token = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
    if (!token) return invalidWriteResponse("GitHub write authentication is not configured on this device", "auth_required");

    let repositoryInfo: { defaultBranch: string | null };
    try {
      repositoryInfo = await fetchGitHubRepositoryInfo(repository, token);
    } catch (error) {
      if (error instanceof GitHubHttpError) {
        return invalidWriteResponse("GitHub repository access failed", error.rateLimited || error.status === 429 ? "rate_limited" : "github_access_failed");
      }
      return invalidWriteResponse("GitHub repository lookup failed", "github_request_failed");
    }
    const base = requestedBase || repositoryInfo.defaultBranch || "";
    if (!base || !safeRef(base)) return invalidWriteResponse("A valid base branch is required", "base_invalid", 400);
    if (base === status.branch) return invalidWriteResponse("The current branch cannot be its own pull request base", "base_is_head", 400);

    try {
      const pullRequest = await createGitHubPullRequest(repository, {
        title,
        body: description,
        head: status.branch,
        base,
      }, token);
      return NextResponse.json({
        ok: true,
        pullRequest,
        target: { repository: `${repository.owner}/${repository.repo}`, head: status.branch, base },
      }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      if (error instanceof GitHubHttpError) {
        return invalidWriteResponse("GitHub pull request creation failed", error.rateLimited || error.status === 429 ? "rate_limited" : "github_write_failed");
      }
      return invalidWriteResponse("GitHub pull request creation failed", "github_write_failed");
    }
  } catch {
    return NextResponse.json({ error: "GitHub pull request operation failed" }, { status: 500 });
  }
}
