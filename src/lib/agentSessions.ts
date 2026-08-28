import { invoke } from '@tauri-apps/api/core';
import type { AgentKind } from './agents';

/** Session record returned by the `list_agent_sessions` IPC. Shape mirrors
 *  the Rust `AgentSessionInfo` struct so the field names cross the wire
 *  unchanged. `preview` is the first user turn excerpt for Claude/Codex,
 *  the chat title for Cursor, and null when no preview is derivable. */
export interface AgentSessionInfo {
  id: string;
  modified_at: string;
  preview: string | null;
}

/** List every prior conversation the agent has stored for `cwd`, newest
 *  first. Antigravity always returns `[]` because its conversations are
 *  cloud-backed and there is no local index to scan. */
export async function listAgentSessions(
  agent: AgentKind,
  cwd: string,
): Promise<AgentSessionInfo[]> {
  return invoke<AgentSessionInfo[]>('list_agent_sessions', { agent, cwd });
}
