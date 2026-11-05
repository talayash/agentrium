import type { AgentKind } from './agents';

export type ViewMode = 'cli' | 'mixed' | 'insight';
export const VIEW_MODES: ViewMode[] = ['cli', 'mixed', 'insight'];

/** Modes a session can use: shells and script children are CLI only, Claude
 *  and Codex support all three, every other agent supports CLI and Mixed. */
export function availableViewModes(t: {
  isShellTerminal?: boolean;
  scriptParentId?: string | null;
  config: { agent?: AgentKind };
}): ViewMode[] {
  if (t.isShellTerminal || t.scriptParentId) return ['cli'];
  const agent = t.config.agent;
  if (agent === 'claude' || agent === 'codex') return [...VIEW_MODES];
  return ['cli', 'mixed'];
}

/** Next mode in cli -> mixed -> insight -> cli order, skipping unavailable ones. */
export function nextViewMode(current: ViewMode, available: ViewMode[]): ViewMode {
  const start = VIEW_MODES.indexOf(current);
  for (let i = 1; i <= VIEW_MODES.length; i++) {
    const candidate = VIEW_MODES[(start + i) % VIEW_MODES.length]!;
    if (available.includes(candidate)) return candidate;
  }
  return current;
}

/** Effective mode of a config. `insight_layer` is the legacy boolean from
 *  before view modes; it maps to Mixed. */
export function viewModeOf(config: { view_mode?: ViewMode; insight_layer?: boolean }): ViewMode {
  return config.view_mode ?? (config.insight_layer ? 'mixed' : 'cli');
}
