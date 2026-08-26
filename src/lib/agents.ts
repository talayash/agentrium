export type AgentKind = 'claude' | 'codex' | 'cursor' | 'gemini';

export interface AgentSpec {
  kind: AgentKind;
  displayName: string;
  binary: string;
  installUrl: string;
  installHint: string;
}

export const AGENT_SPECS: readonly AgentSpec[] = [
  {
    kind: 'claude',
    displayName: 'Claude Code',
    binary: 'claude',
    installUrl: 'https://docs.claude.com/claude-code',
    installHint: 'npm install -g @anthropic-ai/claude-code',
  },
  {
    kind: 'codex',
    displayName: 'Codex',
    binary: 'codex',
    installUrl: 'https://github.com/openai/codex',
    installHint: 'npm install -g @openai/codex',
  },
  {
    kind: 'cursor',
    displayName: 'Cursor',
    // Cursor's CLI binary is `agent`, not `cursor` (per cursor.com/docs/cli).
    binary: 'agent',
    installUrl: 'https://cursor.com/cli',
    installHint: "curl https://cursor.com/install -fsS | bash  (or  irm 'https://cursor.com/install?win32=true' | iex on Windows)",
  },
  {
    kind: 'gemini',
    displayName: 'Gemini',
    binary: 'gemini',
    installUrl: 'https://github.com/google-gemini/gemini-cli',
    installHint: 'npm install -g @google/gemini-cli',
  },
];

export function specFor(kind: AgentKind): AgentSpec {
  const spec = AGENT_SPECS.find(s => s.kind === kind);
  if (!spec) throw new Error(`Unknown agent kind: ${kind}`);
  return spec;
}

// Flags Claude Code accepts that Codex/Cursor reject at arg-parse. Kept
// small on purpose: only strip flags we know are Claude-specific. Unknown
// flags pass through and surface as a CLI error, which is the right signal.
const CLAUDE_ONLY_FLAGS = new Set<string>([
  '--dangerously-skip-permissions',
  '--continue',
  '--worktree',
]);
const CLAUDE_ONLY_FLAGS_WITH_VALUE = new Set<string>([
  '--model',
  '--effort',
  '--resume',
]);

/**
 * Remove flags that only make sense for Claude Code so they don't reach a
 * non-Claude agent. Handles both `--flag value` and `--flag=value` forms.
 * When the target agent IS Claude, args are returned unchanged (a shallow
 * copy so the caller can safely mutate).
 */
export function filterArgsForAgent(agent: AgentKind, args: string[]): string[] {
  if (agent === 'claude') return [...args];
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (CLAUDE_ONLY_FLAGS.has(a)) continue;
    if (CLAUDE_ONLY_FLAGS_WITH_VALUE.has(a)) {
      // Skip the value that follows, unless the next token is another flag
      // (which would mean the value was omitted - unusual but not our
      // problem to diagnose here).
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) i++;
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0) {
      const name = a.slice(0, eq);
      if (CLAUDE_ONLY_FLAGS.has(name) || CLAUDE_ONLY_FLAGS_WITH_VALUE.has(name)) continue;
    }
    out.push(a);
  }
  return out;
}
