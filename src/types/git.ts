export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head_sha: string;
  is_main: boolean;
  is_bare: boolean;
  is_detached: boolean;
}

export interface WorktreeDetectResult {
  is_git_repo: boolean;
  is_worktree: boolean;
  main_repo_path: string | null;
  current_branch: string | null;
  worktree_root: string | null;
}

export interface PushCommit {
  sha: string;
  short_sha: string;
  subject: string;
  author: string;
  time_iso: string;
}

export interface PushPreview {
  local_branch: string;
  remotes: string[];
  default_remote: string;
  default_remote_branch: string;
  has_upstream: boolean;
  commits: PushCommit[];
  ahead: number;
  behind: number;
}

export type PushMode = 'normal' | 'force_with_lease';
