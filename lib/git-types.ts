export type GitFileStatusKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflict";

export interface GitFileStatus {
  filePath: string;
  status: GitFileStatusKind;
  code: "M" | "A" | "D" | "R" | "U" | "C";
  indexStatus: string;
  worktreeStatus: string;
}

export interface GitRemoteInfo {
  name: string;
  url: string;
}

export interface GitCommitSummary {
  hash: string;
  shortHash: string;
  author: string;
  authoredAt: string;
  subject: string;
  refs: string[];
}

export interface GitCommitFile {
  path: string;
  status: string;
  originalPath?: string;
}

export interface GitCommitDetail extends GitCommitSummary {
  files: GitCommitFile[];
}

export interface GitStatusResponse {
  isGitRepository: boolean;
  repositoryRoot: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
  additions: number;
  deletions: number;
}

export interface GitFileDiffResponse {
  supported: boolean;
  status?: GitFileStatusKind;
  patch?: string;
}
