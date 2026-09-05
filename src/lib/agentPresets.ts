// Static tables behind the Add Agent / Add API Key dialogs. Colours must
// match `ALLOWED_COLORS` in src-tauri/src/custom_agents.rs - the backend
// rejects anything else.

export const AGENT_COLORS = ['#30C55E', '#3899FF', '#FFA028', '#B48CFF', '#FF6B8A', '#5AC8FA'] as const;
export type AgentColor = (typeof AGENT_COLORS)[number];

export const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

export interface AgentPreset {
  id: string;
  name: string;
  binary: string;
  defaultArgs: string[];
  /** `--session {id}` style, or a `--continue` style flag, or null. */
  resumeFlag: string | null;
  color: AgentColor;
  requiredEnv: string[];
  installUrl: string | null;
  installHint: string | null;
}

export const AGENT_PRESETS: readonly AgentPreset[] = [
  {
    id: 'opencode', name: 'OpenCode', binary: 'opencode',
    defaultArgs: [], resumeFlag: '--session {id}', color: '#30C55E',
    requiredEnv: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
    installUrl: 'https://opencode.ai/docs', installHint: 'npm install -g opencode-ai',
  },
  {
    id: 'gemini', name: 'Gemini CLI', binary: 'gemini',
    defaultArgs: [], resumeFlag: '--resume {id}', color: '#3899FF',
    requiredEnv: ['GEMINI_API_KEY'],
    installUrl: 'https://github.com/google-gemini/gemini-cli', installHint: 'npm install -g @google/gemini-cli',
  },
  {
    id: 'aider', name: 'Aider', binary: 'aider',
    defaultArgs: [], resumeFlag: '--restore-chat-history', color: '#FFA028',
    requiredEnv: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
    installUrl: 'https://aider.chat/docs/install.html', installHint: 'python -m pip install aider-install && aider-install',
  },
  {
    id: 'goose', name: 'Goose', binary: 'goose',
    defaultArgs: [], resumeFlag: '--resume', color: '#B48CFF',
    requiredEnv: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
    installUrl: 'https://block.github.io/goose/docs/getting-started/installation', installHint: 'curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash',
  },
  {
    id: 'qwen', name: 'Qwen Code', binary: 'qwen',
    defaultArgs: [], resumeFlag: null, color: '#FF6B8A',
    requiredEnv: ['OPENAI_API_KEY'],
    installUrl: 'https://github.com/QwenLM/qwen-code', installHint: 'npm install -g @qwen-code/qwen-code',
  },
  {
    id: 'custom', name: '', binary: '',
    defaultArgs: [], resumeFlag: null, color: '#5AC8FA',
    requiredEnv: [], installUrl: null, installHint: null,
  },
];

export type ProviderId = 'anthropic' | 'openai' | 'google' | 'cursor' | 'openrouter' | 'custom';

export const PROVIDERS: readonly { id: ProviderId; label: string }[] = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'google', label: 'Google' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'custom', label: 'Custom' },
];

export interface ProviderDefaults {
  envName: string;
  endpointEnv: string | null;
  defaultEndpoint: string | null;
}

export function providerDefaults(id: ProviderId): ProviderDefaults {
  switch (id) {
    case 'anthropic': return { envName: 'ANTHROPIC_API_KEY', endpointEnv: 'ANTHROPIC_BASE_URL', defaultEndpoint: 'https://api.anthropic.com' };
    case 'openai': return { envName: 'OPENAI_API_KEY', endpointEnv: 'OPENAI_BASE_URL', defaultEndpoint: 'https://api.openai.com/v1' };
    case 'google': return { envName: 'GEMINI_API_KEY', endpointEnv: null, defaultEndpoint: null };
    case 'cursor': return { envName: 'CURSOR_API_KEY', endpointEnv: null, defaultEndpoint: null };
    case 'openrouter': return { envName: 'OPENROUTER_API_KEY', endpointEnv: 'OPENAI_BASE_URL', defaultEndpoint: 'https://openrouter.ai/api/v1' };
    case 'custom': return { envName: '', endpointEnv: null, defaultEndpoint: null };
  }
}

/** Env var names that look like secrets - drives the Profile modal's
 *  "Move to keychain" action and the one-time migration prompt. */
export const SECRET_ENV_RE = /(_API_KEY|_TOKEN|_SECRET)$/;
