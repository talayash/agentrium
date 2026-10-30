import { useTerminalStore, type TerminalInstance } from '../store/terminalStore';
import { sessionDisplayName } from './sessionContext';

/** Mirrors Rust `terminal::supports_fork`: only Claude and Codex CLIs can
 *  branch an existing conversation. */
const FORKABLE_AGENTS: readonly string[] = ['claude', 'codex'];

/** True when the session has a saved conversation on an agent that can fork it. */
export function canFork(t: TerminalInstance): boolean {
  return FORKABLE_AGENTS.includes(t.config.agent ?? 'claude') && !!t.config.claude_session_id;
}

/** Start a new session that branches the source's conversation. The source is
 *  left untouched. Returns the new terminal id. */
export async function forkSession(sourceId: string): Promise<string> {
  const source = useTerminalStore.getState().terminals.get(sourceId);
  if (!source) throw new Error('The source session is no longer open.');
  if (!canFork(source)) throw new Error("This agent can't fork a conversation.");
  const { config } = source;
  return useTerminalStore.getState().createTerminal(
    `Fork: ${sessionDisplayName(source)}`, config.working_directory,
    config.claude_args, {},
    undefined, undefined, undefined, config.claude_session_id ?? undefined, false, undefined,
    config.agent ?? 'claude', config.credential_bindings ?? [], config.task ?? null,
    { fork: true },
  );
}
