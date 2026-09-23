import { listAgentSessions, type AgentSessionInfo } from './agentSessions';
import type { AgentKind } from './agents';
import type { CredentialBinding } from './credentials';

export interface HistoryProfile {
  id: string;
  name: string;
  working_directory: string;
  agent?: AgentKind;
  claude_args: string[];
  agent_args?: Partial<Record<AgentKind, string[]>>;
  env_vars: Record<string, string>;
  credential_bindings?: CredentialBinding[];
  preview?: { enabled: boolean; url_override?: string | null; framework_hint?: string | null } | null;
}

export interface HistorySession extends AgentSessionInfo { agent: AgentKind }
export interface HistoryGroup {
  id: string;
  name: string;
  cwd: string;
  profile?: HistoryProfile;
  sessions: HistorySession[];
  error?: string;
  unsupported?: boolean;
}

const indexedAgents: AgentKind[] = ['claude', 'codex', 'cursor'];

export function historyPathKey(path: string): string {
  const windows = /^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\');
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return windows ? normalized.toLowerCase() : normalized;
}

function newest(sessions: HistorySession[]): HistorySession[] {
  const unique = new Map(sessions.map(s => [`${s.agent}:${s.id}`, s]));
  return [...unique.values()].sort((a, b) => Date.parse(b.modified_at) - Date.parse(a.modified_at)).slice(0, 5);
}

/** Cache per folder/agent for this refresh, including rejected requests. */
export async function loadHistoryGroups(profiles: HistoryProfile[], folders: string[], isCurrent = () => true): Promise<HistoryGroup[]> {
  const requests = new Map<string, Promise<HistorySession[]>>();
  const covered = new Set<string>();
  const keyFor = (agent: AgentKind, cwd: string) => JSON.stringify([agent, historyPathKey(cwd)]);
  const list = (agent: AgentKind, cwd: string) => {
    const key = keyFor(agent, cwd);
    let request = requests.get(key);
    if (!request) {
      request = listAgentSessions(agent, cwd).then(rows => rows.map(s => ({ ...s, agent })));
      requests.set(key, request);
    }
    return request;
  };
  const profileGroups: HistoryGroup[] = [];
  // Keep I/O bounded instead of scanning every historical folder at once.
  for (const profile of profiles) {
    if (!isCurrent()) return [];
    const agent = profile.agent ?? 'claude';
    const cwd = profile.working_directory;
    covered.add(keyFor(agent, cwd));
    const group: HistoryGroup = { id: `profile:${profile.id}`, name: profile.name, cwd, profile, sessions: [] };
    if (!cwd.trim()) group.error = 'This profile has no working directory.';
    else if (!indexedAgents.includes(agent)) group.unsupported = true;
    else {
      try { group.sessions = newest(await list(agent, cwd)); }
      catch (err) { group.error = `Could not load sessions: ${String(err)}`; }
    }
    // Failed lookups remain visible so an error is not mistaken for no history.
    if (group.sessions.length || group.error) profileGroups.push(group);
  }
  const uniqueFolders = new Map<string, string>();
  for (const cwd of folders) {
    if (cwd.trim() && !uniqueFolders.has(historyPathKey(cwd))) uniqueFolders.set(historyPathKey(cwd), cwd);
  }
  const folderGroups: HistoryGroup[] = [];
  for (const [key, cwd] of uniqueFolders) {
    if (!isCurrent()) return [];
    const agents = indexedAgents.filter(agent => !covered.has(keyFor(agent, cwd)));
    const results = await Promise.allSettled(agents.map(agent => list(agent, cwd)));
    const sessions = newest(results.flatMap(r => r.status === 'fulfilled' ? r.value : []));
    const failed = results.some(r => r.status === 'rejected');
    if (sessions.length || failed) folderGroups.push({
      id: `folder:${key}`, name: cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd,
      cwd, sessions, error: failed ? 'Some agent sessions could not be loaded. Try refreshing.' : undefined,
    });
  }
  folderGroups.sort((a, b) => (Date.parse(b.sessions[0]?.modified_at ?? '') || 0) - (Date.parse(a.sessions[0]?.modified_at ?? '') || 0));
  return [...profileGroups, ...folderGroups];
}
