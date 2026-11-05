import type { AgentKind } from './agents';

export type ViewMode = 'cli' | 'mixed' | 'insight';
export const VIEW_MODES: ViewMode[] = ['cli', 'mixed', 'insight'];

/** Modes a session can use: shells and script children are CLI only, Claude
 *  supports all three, every other agent (Codex included) supports CLI and
 *  Mixed. Codex stays out of Insight until it has its own send path: the
 *  prompt bar and question box drive Claude's TUI. */
export function availableViewModes(t: {
  isShellTerminal?: boolean;
  scriptParentId?: string | null;
  config: { agent?: AgentKind };
}): ViewMode[] {
  if (t.isShellTerminal || t.scriptParentId) return ['cli'];
  const agent = t.config.agent;
  if (agent === 'claude') return [...VIEW_MODES];
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

/** Tooltip for a disabled Insight segment, per agent. */
export function insightUnavailableReason(agent: AgentKind | undefined): string {
  if (agent === 'codex') return 'Insight view is not available for Codex yet';
  return 'No structured data for this agent';
}

export const VIEW_MODE_LABELS: Record<ViewMode, string> = { cli: 'CLI', mixed: 'Mixed', insight: 'Insight' };

type ViewModeTerminal = Parameters<typeof availableViewModes>[0] & {
  config: { view_mode?: ViewMode; insight_layer?: boolean };
};

/** The mode a session is really in: the configured mode when this agent
 *  supports it, otherwise Mixed (or CLI when Mixed is unavailable too). */
export function effectiveViewMode(t: ViewModeTerminal): ViewMode {
  const available = availableViewModes(t);
  const wanted = viewModeOf(t.config);
  if (available.includes(wanted)) return wanted;
  return available.includes('mixed') ? 'mixed' : 'cli';
}

/** Command Palette entries for a session: one per available mode, or none
 *  when only CLI is available (nothing to switch). */
export function viewModePaletteEntries(t: ViewModeTerminal): { mode: ViewMode; label: string }[] {
  const available = availableViewModes(t);
  if (available.length < 2) return [];
  return available.map((mode) => ({ mode, label: `View: ${VIEW_MODE_LABELS[mode]}` }));
}
