import type { SessionState } from './terminalState';

/** Sidebar session groups, ordered by how urgently they need the user. */
export type AttentionGroup = 'needs-you' | 'working' | 'idle';

export const GROUP_ORDER: AttentionGroup[] = ['needs-you', 'working', 'idle'];

export const GROUP_LABEL: Record<AttentionGroup, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  idle: 'Idle',
};

interface SessionSignals {
  /** Process status from the backend (`TerminalConfig.status`). */
  status: string;
  /** Detected session state from terminal output; undefined before detection. */
  state: SessionState | undefined;
  /** An unacknowledged alert: waiting prompt or finished turn not yet viewed. */
  pendingAttention: boolean;
}

export function classifySession({ status, state, pendingAttention }: SessionSignals): AttentionGroup {
  // A waiting prompt stays here after the alert is acknowledged: the agent is
  // still blocked on the user until they answer.
  if (pendingAttention || state === 'waiting' || status === 'Error') return 'needs-you';
  // Match the card's busy pulse: a stopped process is never "working".
  if (status === 'Running' && state === 'busy') return 'working';
  return 'idle';
}

/** Buckets ids by group, keeping the input order inside each; empty groups are dropped. */
export function groupSessionIds(
  ids: string[],
  groupOf: (id: string) => AttentionGroup,
): { group: AttentionGroup; ids: string[] }[] {
  const buckets = new Map<AttentionGroup, string[]>(GROUP_ORDER.map((g) => [g, []]));
  for (const id of ids) buckets.get(groupOf(id))!.push(id);
  return GROUP_ORDER.filter((g) => buckets.get(g)!.length > 0).map((g) => ({ group: g, ids: buckets.get(g)! }));
}

/**
 * Applies a drag inside one group to the full session order: the slots the
 * group's members occupy stay where they are and are refilled in the new
 * order, so sessions in other groups never move.
 */
export function mergeGroupOrder(full: string[], reorderedGroup: string[]): string[] {
  const members = new Set(full);
  const next = reorderedGroup.filter((id) => members.has(id));
  const inGroup = new Set(next);
  let i = 0;
  return full.map((id) => (inGroup.has(id) ? next[i++] : id));
}
