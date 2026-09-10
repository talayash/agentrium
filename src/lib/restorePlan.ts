// Decide how each terminal in a saved session gets reattached to Claude on
// restore. The invariant this file exists to protect: NO two restored
// terminals may attach to the same Claude session. When several terminals
// share a working directory, their captured session ids can collide (they all
// see each other's session files), and the `--continue` fallback always picks
// the single newest session in the cwd - so without deduplication a restore
// quietly collapses every same-project terminal into ONE shared conversation.
// Users experience that as "what I paste/type in one terminal appears in all
// other terminal tabs".

export interface RestorePlanInput {
  agent?: string;
  claude_session_id?: string | null;
  working_directory: string;
  /** Saved spawn args; `__shell__` / `__script__` sentinels mark non-claude
   * terminals that never attach to a session. */
  claude_args?: string[];
}

export type RestoreMode =
  | { kind: 'resume'; sessionId: string }
  | { kind: 'continue' }
  | { kind: 'fresh' };

/**
 * Assign a restore mode to each terminal, in order:
 *  - First terminal to claim a captured session id → `--resume <id>`.
 *  - Duplicate claims of the same id → fresh spawn (painted scrollback keeps
 *    the visual context; attaching a second process to the same conversation
 *    is never correct).
 *  - First id-less terminal in a cwd → `--continue` (newest session there).
 *  - Further id-less terminals in the same cwd → fresh spawn, for the same
 *    reason.
 */
export function planRestoreModes(configs: RestorePlanInput[]): RestoreMode[] {
  const isAgent = (c: RestorePlanInput) => !['__shell__', '__script__'].includes(c.claude_args?.[0] ?? '');
  const directoryKey = (c: RestorePlanInput) => {
    let path = c.working_directory.replace(/\\/g, '/').replace(/\/+$/, '');
    // Fold drive/UNC paths only; Unix filesystems may distinguish case.
    if (/^[a-z]:/i.test(path) || path.startsWith('//')) path = path.toLowerCase();
    return JSON.stringify([c.agent ?? 'claude', path]);
  };
  // Reserve all explicit claims before assigning continuation, regardless of order.
  const reservedCwds = new Set(configs.filter(c => isAgent(c) && c.claude_session_id).map(directoryKey));
  const usedSessionIds = new Set<string>();
  const continuedCwds = new Set<string>();

  return configs.map((config) => {
    // Shells and script runners never attach to a Claude session; give them a
    // placeholder mode so they can't consume a cwd's single --continue slot.
    const sentinel = config.claude_args?.[0];
    if (sentinel === '__shell__' || sentinel === '__script__') {
      return { kind: 'fresh' };
    }
    const sessionId = config.claude_session_id ?? null;
    if (sessionId) {
      const sessionKey = JSON.stringify([config.agent ?? 'claude', sessionId]);
      if (usedSessionIds.has(sessionKey)) return { kind: 'fresh' };
      usedSessionIds.add(sessionKey);
      return { kind: 'resume', sessionId };
    }
    // Windows paths are case-insensitive; normalize so "C:\Dev" and "c:\dev"
    // count as the same project.
    const cwd = directoryKey(config);
    if (reservedCwds.has(cwd)) return { kind: 'fresh' };
    if (continuedCwds.has(cwd)) return { kind: 'fresh' };
    continuedCwds.add(cwd);
    return { kind: 'continue' };
  });
}
