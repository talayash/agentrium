/**
 * Decides whether the sidebar Session card's rename input should persist a
 * new nickname when the user commits (Enter / blur), and what value to persist.
 * Extracted here so the component just wires event handlers - the decision
 * logic is trivially unit-testable and free of Zustand / IPC coupling.
 *
 * Rules:
 *   - Trim the raw input.
 *   - If the trimmed value equals the currently-persisted nickname (with null
 *     treated as ""), it's a no-op - the user pressed Enter without changing
 *     anything, or added incidental whitespace.
 *   - Otherwise commit the trimmed value. Committing "" clears the nickname
 *     so `name = nickname || label` falls back to the profile-derived label.
 */
export interface RenameInput {
  currentNickname: string | null;
  raw: string;
}

export interface RenameCommit {
  shouldCommit: boolean;
  /** Value to pass to `updateNickname`. Meaningful only when
   *  `shouldCommit === true`; otherwise it's an empty placeholder. */
  nickname: string;
}

export function resolveRenameCommit({ currentNickname, raw }: RenameInput): RenameCommit {
  const trimmed = raw.trim();
  const currentNorm = currentNickname ?? '';
  if (trimmed === currentNorm) {
    return { shouldCommit: false, nickname: '' };
  }
  return { shouldCommit: true, nickname: trimmed };
}
