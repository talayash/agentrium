export type AgentKind = 'claude' | 'codex';

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
];

export function specFor(kind: AgentKind): AgentSpec {
  const spec = AGENT_SPECS.find(s => s.kind === kind);
  if (!spec) throw new Error(`Unknown agent kind: ${kind}`);
  return spec;
}
