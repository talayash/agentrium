import { useMemo } from 'react';
import { useAttentionStore } from '../store/attentionStore';
import { useTerminalStore } from '../store/terminalStore';
import { useTaskObservationStore } from '../store/taskObservationStore';
import { usePrStore } from '../store/prStore';
import { useRaceStore } from '../store/raceStore';
import { useAgentRegistryStore } from '../store/agentRegistryStore';
import { terminalPrTarget } from '../lib/pullRequestActions';
import { allAgentSpecs } from '../lib/agents';
import { buildReviewQueue, pendingItemCount, type ReviewEntry } from '../lib/reviewQueue';

function agentName(kind: string): string {
  return allAgentSpecs().find(s => s.kind === kind)?.displayName ?? kind;
}

/** Live Review Queue entries, derived from the attention store plus observed
 *  task, PR and check state. Re-renders only when one of those changes. */
export function useReviewQueue(): ReviewEntry[] {
  const items = useAttentionStore((s) => s.items);
  const terminals = useTerminalStore((s) => s.terminals);
  const terminalStates = useTerminalStore((s) => s.terminalStates);
  const gitInfoCache = useTerminalStore((s) => s.gitInfoCache);
  const tasks = useTaskObservationStore((s) => s.byTerminal);
  const prRefs = usePrStore((s) => s.refs);
  const prStatuses = usePrStore((s) => s.statuses);
  const races = useRaceStore((s) => s.races);
  const checks = useRaceStore((s) => s.checks);
  // Custom agent names resolve through the registry.
  const customAgents = useAgentRegistryStore((s) => s.customAgents);
  return useMemo(() => buildReviewQueue({
    items, terminals, terminalStates, tasks, races, checks, agentName,
    prStatus: (id) => {
      const target = terminalPrTarget(id);
      return target && prRefs[target.key] ? prStatuses[target.key] : undefined;
    },
  }), [items, terminals, terminalStates, gitInfoCache, tasks, prRefs, prStatuses, races, checks, customAgents]);
}

/** Entries still waiting on the user, for the title-bar badge. */
export function useReviewPendingCount(): number {
  const items = useAttentionStore((s) => s.items);
  return useMemo(() => pendingItemCount(items), [items]);
}
