export type AgentKind = 'claude' | 'codex' | 'cursor';

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
];

export function specFor(kind: AgentKind): AgentSpec {
  const spec = AGENT_SPECS.find(s => s.kind === kind);
  if (!spec) throw new Error(`Unknown agent kind: ${kind}`);
  return spec;
}
