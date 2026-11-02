import type { GitRemoteInfo } from "./git-types";

export interface GitHubRepository {
  owner: string;
  repo: string;
  remoteName: string;
}

export type GitHubUnavailableReason =
  | "no-github-remote"
  | "auth-required"
  | "auth-failed"
  | "repository-not-found"
  | "rate-limited"
  | "request-failed";

export interface GitHubPullRequest {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  author: string | null;
  base: string;
  head: string;
  updatedAt: string;
  htmlUrl: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  author: string | null;
  updatedAt: string;
  htmlUrl: string;
}

export interface GitHubCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  htmlUrl: string | null;
}

export interface GitHubReadOnlySnapshot {
  available: boolean;
  repository: GitHubRepository | null;
  branch: string | null;
  checkedRef: string | null;
  defaultBranch: string | null;
  pullRequests: GitHubPullRequest[];
  issues: GitHubIssue[];
  checks: GitHubCheckRun[];
  warnings: string[];
  reason?: GitHubUnavailableReason;
}

const GITHUB_HOST = "github.com";
const GITHUB_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function validName(value: string): boolean {
  return value.length > 0 && value.length <= 100 && GITHUB_NAME_RE.test(value);
}

function repositoryParts(rawUrl: string): [string, string] | null {
  const value = rawUrl.trim();
  let rawPath = "";
  if (/^(?:https?|git\+ssh):\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (parsed.hostname.toLowerCase() !== GITHUB_HOST || parsed.search || parsed.hash || parsed.pathname.includes("\\0")) return null;
      rawPath = parsed.pathname;
    } catch {
      return null;
    }
  } else if (/^git@github\.com:/i.test(value)) {
    rawPath = value.slice(value.indexOf(":") + 1);
  } else if (/^ssh:\/\/git@github\.com\//i.test(value)) {
    rawPath = value.slice(value.indexOf("//") + 2).replace(/^git@github\.com\//i, "/");
  } else {
    return null;
  }

  const parts = rawPath.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").split("/");
  if (parts.length !== 2 || !validName(parts[0]) || !validName(parts[1])) return null;
  return [parts[0], parts[1]];
}

export function parseGitHubRemote(remote: GitRemoteInfo): GitHubRepository | null {
  const parts = repositoryParts(remote.url);
  return parts ? { owner: parts[0], repo: parts[1], remoteName: remote.name } : null;
}

export function selectGitHubRepository(remotes: GitRemoteInfo[]): GitHubRepository | null {
  const ordered = [...remotes].sort((a, b) => {
    const rank = (name: string) => name === "origin" ? 0 : name === "upstream" ? 1 : 2;
    return rank(a.name) - rank(b.name);
  });
  for (const remote of ordered) {
    const repository = parseGitHubRemote(remote);
    if (repository) return repository;
  }
  return null;
}

function boundedText(value: unknown, max = 400): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function safeGitHubUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname.toLowerCase() === GITHUB_HOST ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

export function parseGitHubPullRequests(value: unknown, repository: GitHubRepository): GitHubPullRequest[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const number = positiveNumber(record.number);
    if (number === null) return [];
    return [{
      number,
      title: boundedText(record.title) || "(untitled)",
      state: boundedText(record.state) || "unknown",
      draft: record.draft === true,
      author: record.user && typeof record.user === "object" ? boundedText((record.user as Record<string, unknown>).login, 100) || null : null,
      base: record.base && typeof record.base === "object" ? boundedText((record.base as Record<string, unknown>).ref, 100) : "",
      head: record.head && typeof record.head === "object" ? boundedText((record.head as Record<string, unknown>).ref, 100) : "",
      updatedAt: boundedText(record.updated_at, 80),
      htmlUrl: safeGitHubUrl(record.html_url) ?? `https://${GITHUB_HOST}/${repository.owner}/${repository.repo}/pull/${number}`,
    }];
  });
}

export function parseGitHubIssues(value: unknown, repository: GitHubRepository): GitHubIssue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const number = positiveNumber(record.number);
    if (number === null || record.pull_request) return [];
    return [{
      number,
      title: boundedText(record.title) || "(untitled)",
      state: boundedText(record.state) || "unknown",
      author: record.user && typeof record.user === "object" ? boundedText((record.user as Record<string, unknown>).login, 100) || null : null,
      updatedAt: boundedText(record.updated_at, 80),
      htmlUrl: safeGitHubUrl(record.html_url) ?? `https://${GITHUB_HOST}/${repository.owner}/${repository.repo}/issues/${number}`,
    }];
  });
}

export function parseGitHubChecks(value: unknown): GitHubCheckRun[] {
  if (!value || typeof value !== "object") return [];
  const runs = (value as Record<string, unknown>).check_runs;
  if (!Array.isArray(runs)) return [];
  return runs.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const name = boundedText(record.name, 160);
    if (!name) return [];
    return [{
      name,
      status: boundedText(record.status, 40) || "unknown",
      conclusion: boundedText(record.conclusion, 40) || null,
      startedAt: boundedText(record.started_at, 80) || null,
      completedAt: boundedText(record.completed_at, 80) || null,
      htmlUrl: safeGitHubUrl(record.html_url),
    }];
  });
}

export function githubApiUrl(repository: GitHubRepository, endpoint: string, query = ""): string {
  return `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/${endpoint}${query}`;
}


export class GitHubHttpError extends Error {
  constructor(readonly status: number, readonly rateLimited = false) {
    super(`GitHub HTTP ${status}`);
  }
}

export type GitHubFetcher = (input: string, init?: RequestInit) => Promise<Response>;

async function fetchGitHubJson(
  url: string,
  token: string,
  fetcher: GitHubFetcher,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetcher(url, {
    ...init,
    cache: "no-store",
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "pi-web-reader",
      Authorization: `Bearer ${token}`,
      ...(init.headers && typeof init.headers === "object" && !Array.isArray(init.headers) ? init.headers as Record<string, string> : {}),
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    throw new GitHubHttpError(response.status, response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
  }
  return response.json();
}

export interface GitHubPullRequestCreateInput {
  title: string;
  body: string;
  head: string;
  base: string;
}

export interface GitHubPullRequestCreated {
  number: number;
  htmlUrl: string;
}

export async function fetchGitHubRepositoryInfo(
  repository: GitHubRepository,
  token: string,
  fetcher: GitHubFetcher = fetch,
): Promise<{ defaultBranch: string | null }> {
  const raw = await fetchGitHubJson(githubApiUrl(repository, ""), token, fetcher);
  const defaultBranch = raw && typeof raw === "object"
    ? boundedText((raw as Record<string, unknown>).default_branch, 100) || null
    : null;
  return { defaultBranch };
}

export async function createGitHubPullRequest(
  repository: GitHubRepository,
  input: GitHubPullRequestCreateInput,
  token: string,
  fetcher: GitHubFetcher = fetch,
): Promise<GitHubPullRequestCreated> {
  const raw = await fetchGitHubJson(githubApiUrl(repository, "pulls"), token, fetcher, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!raw || typeof raw !== "object") throw new Error("GitHub returned an invalid pull request");
  const record = raw as Record<string, unknown>;
  const number = positiveNumber(record.number);
  if (number === null) throw new Error("GitHub returned an invalid pull request");
  return {
    number,
    htmlUrl: safeGitHubUrl(record.html_url) ?? `https://${GITHUB_HOST}/${repository.owner}/${repository.repo}/pull/${number}`,
  };
}

export async function fetchGitHubReadOnlySnapshot(
  repository: GitHubRepository,
  branch: string | null,
  head: string | null,
  token: string,
  fetcher: GitHubFetcher = fetch,
): Promise<GitHubReadOnlySnapshot> {
  const repositoryInfo = await fetchGitHubRepositoryInfo(repository, token, fetcher);
  const checkedRef = branch || head;
  const requests: Array<{ key: "pullRequests" | "issues" | "checks"; url: string }> = [
    { key: "pullRequests", url: githubApiUrl(repository, "pulls", "?state=open&per_page=20") },
    { key: "issues", url: githubApiUrl(repository, "issues", "?state=open&per_page=20") },
  ];
  if (checkedRef) {
    requests.push({
      key: "checks",
      url: githubApiUrl(repository, `commits/${encodeURIComponent(checkedRef)}/check-runs`, "?per_page=20"),
    });
  }

  const settled = await Promise.allSettled(requests.map((request) => fetchGitHubJson(request.url, token, fetcher)));
  const values = new Map<string, unknown>();
  const warnings: string[] = [];
  requests.forEach((request, index) => {
    const result = settled[index];
    if (result.status === "fulfilled") values.set(request.key, result.value);
    else warnings.push(request.key);
  });

  return {
    available: true,
    repository,
    branch,
    checkedRef,
    defaultBranch: repositoryInfo.defaultBranch,
    pullRequests: parseGitHubPullRequests(values.get("pullRequests"), repository),
    issues: parseGitHubIssues(values.get("issues"), repository),
    checks: parseGitHubChecks(values.get("checks")),
    warnings,
  };
}
