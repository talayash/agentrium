export type BuiltinAgentKind = 'claude' | 'codex' | 'cursor' | 'antigravity';
export type AgentKind = BuiltinAgentKind | `custom:${string}`;

export const BUILTIN_AGENT_KINDS: readonly BuiltinAgentKind[] = ['claude', 'codex', 'cursor', 'antigravity'];

export function isCustomAgent(kind: AgentKind): kind is `custom:${string}` {
  return kind.startsWith('custom:');
}
export function customKind(id: string): `custom:${string}` {
  return `custom:${id}`;
}
export function customIdOf(kind: AgentKind): string | null {
  return isCustomAgent(kind) ? kind.slice('custom:'.length) : null;
}

export interface AgentSpec {
  kind: AgentKind;
  displayName: string;
  binary: string;
  installUrl: string;
  installHint: string;
  /**
   * Placeholder text shown in the args textarea. Not persisted, purely
   * a hint - real defaults live in `appStore.defaultAgentArgs[kind]`.
   * Newline-separated so it can preview a multi-flag setup.
   */
  defaultArgsHint: string;
  /** Custom agents only. */
  color?: string;
  monogram?: string;
  defaultArgs?: string[];
  resumeFlag?: string | null;
  requiredEnv?: string[];
}

export const AGENT_SPECS: readonly AgentSpec[] = [
  {
    kind: 'claude',
    displayName: 'Claude Code',
    binary: 'claude',
    installUrl: 'https://docs.claude.com/claude-code',
    installHint: 'npm install -g @anthropic-ai/claude-code',
    defaultArgsHint: '--dangerously-skip-permissions\n--model opus',
  },
  {
    kind: 'codex',
    displayName: 'Codex',
    binary: 'codex',
    installUrl: 'https://github.com/openai/codex',
    installHint: 'npm install -g @openai/codex',
    defaultArgsHint: '--dangerously-bypass-approvals-and-sandbox',
  },
  {
    kind: 'cursor',
    displayName: 'Cursor',
    // Cursor's CLI binary is `agent`, not `cursor` (per cursor.com/docs/cli).
    binary: 'agent',
    installUrl: 'https://cursor.com/cli',
    installHint: "curl https://cursor.com/install -fsS | bash  (or  irm 'https://cursor.com/install?win32=true' | iex on Windows)",
    defaultArgsHint: '--print       # non-interactive mode',
  },
  {
    kind: 'antigravity',
    displayName: 'Antigravity',
    // Antigravity CLI's binary is literally `agy` (per
    // antigravity.google/docs/cli), NOT `antigravity`. Guard against
    // future edits that "correct" this to the intuitive-but-wrong name.
    binary: 'agy',
    installUrl: 'https://antigravity.google/docs/cli/install/',
    installHint: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    // Don't hint `--model` here: filterArgsForAgent strips typed --model
    // pairs from non-Claude agents (the picker injects it instead), so a
    // --model hint would suggest an arg that silently disappears.
    defaultArgsHint: '--sandbox       # terminal restrictions',
  },
];

let customSpecs: AgentSpec[] = [];
export function setCustomAgentSpecs(specs: AgentSpec[]) {
  customSpecs = specs;
}
export function allAgentSpecs(): AgentSpec[] {
  return [...AGENT_SPECS, ...customSpecs];
}

export function specFor(kind: AgentKind): AgentSpec {
  const spec = allAgentSpecs().find(s => s.kind === kind);
  if (!spec) throw new Error(`Unknown agent kind: ${kind}`);
  return spec;
}

export function monogramFor(name: string): string {
  const trimmed = name.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  // Single word: try CamelCase split ("OpenCode" -> "OC") before falling
  // back to the first two characters.
  const camel = trimmed.match(/[A-Z][a-z]*/g);
  if (camel && camel.length >= 2) return (camel[0][0] + camel[1][0]).toUpperCase();
  return trimmed.slice(0, 2).toUpperCase() || '?';
}

export function defaultArgsFor(kind: AgentKind, builtinMap: Record<BuiltinAgentKind, string[]>): string[] {
  if (isCustomAgent(kind)) return [...(specFor(kind).defaultArgs ?? [])];
  return builtinMap[kind] ?? [];
}

// Per-agent set of flags that must be stripped before spawning that agent
// because they either mean something Claude-specific or would be an
// arg-parse error on the target.
// - `--dangerously-skip-permissions`: Claude-only permission bypass.
// - `--worktree`: Claude-only spawn mode.
// - `--continue`: valid on Claude/Cursor/Antigravity, but Codex uses the
//   `resume --last` subcommand instead - a raw `--continue` on Codex errors.
const NO_VALUE_STRIP: Record<BuiltinAgentKind, ReadonlySet<string>> = {
  claude: new Set(),
  codex: new Set(['--dangerously-skip-permissions', '--worktree', '--continue']),
  cursor: new Set(['--dangerously-skip-permissions', '--worktree']),
  antigravity: new Set(['--dangerously-skip-permissions', '--worktree']),
};

// Flags that consume the next token as their value; the value must be
// dropped alongside the flag. `--resume` is Claude-shape - other agents
// have their own resume form injected by the backend's resume_flags_for.
// `--model` / `--effort`: the other CLIs do accept a `--model` flag, but
// a VALUE typed for Claude (e.g. `opus`, `sonnet[1m]`) is an unknown model
// to them, so reused Claude args must lose the pair. The New Terminal
// modal injects the per-agent model picked from `agentModels.ts` AFTER
// this filter runs, so the picker is the supported way to set a model.
const WITH_VALUE_STRIP: Record<BuiltinAgentKind, ReadonlySet<string>> = {
  claude: new Set(),
  codex: new Set(['--model', '--effort', '--resume']),
  cursor: new Set(['--model', '--effort', '--resume']),
  antigravity: new Set(['--model', '--effort', '--resume']),
};

/**
 * Remove flags that the target agent can't accept. Handles both
 * `--flag value` and `--flag=value` forms. When the target agent
 * is Claude, args are returned unchanged (a shallow copy so the
 * caller can safely mutate).
 */
export function filterArgsForAgent(agent: AgentKind, args: string[]): string[] {
  if (agent === 'claude') return [...args];
  const key: BuiltinAgentKind = isCustomAgent(agent) ? 'cursor' : agent;
  const noValue = NO_VALUE_STRIP[key];
  const withValue = WITH_VALUE_STRIP[key];
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (noValue.has(a)) continue;
    if (withValue.has(a)) {
      // Skip the value that follows, unless the next token looks like
      // another flag (which would mean the value was omitted - unusual
      // but not our problem to diagnose here).
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) i++;
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0) {
      const name = a.slice(0, eq);
      if (noValue.has(name) || withValue.has(name)) continue;
    }
    out.push(a);
  }
  return out;
}
