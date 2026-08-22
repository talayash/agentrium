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
  /** Count of files with staged/unstaged/untracked changes. 0 = clean tree. */
  dirty_count: number | null;
  /** Commits ahead of upstream. null = no upstream tracked. */
  ahead: number | null;
  /** Commits behind upstream. null = no upstream tracked. */
  behind: number | null;
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

export type HunkActionKind = 'stage' | 'discard';

export interface HunkAction {
  kind: HunkActionKind;
  repoPath: string;
  filePath: string;
  hunkPatch: string;
  atLine: number;   // header line number for toast label
  timestamp: number;
}

export interface UndoResult {
  ok: number;
  failed: number;
}
