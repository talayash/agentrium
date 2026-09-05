import { describe, it, expect } from 'vitest';
import { AGENT_PRESETS, AGENT_COLORS, PROVIDERS, providerDefaults, ENV_NAME_RE } from './agentPresets';

describe('agent presets', () => {
  it('every preset has a binary, an allowed colour, and valid env names', () => {
    for (const p of AGENT_PRESETS) {
      if (p.id !== 'custom') {
        expect(p.binary.length).toBeGreaterThan(0);
      }
      expect(AGENT_COLORS).toContain(p.color);
      for (const e of p.requiredEnv) expect(e).toMatch(ENV_NAME_RE);
    }
  });

  it('ships the five agreed presets plus a custom entry', () => {
    expect(AGENT_PRESETS.map(p => p.id)).toEqual(['opencode', 'gemini', 'aider', 'goose', 'qwen', 'custom']);
  });

  it('provider defaults map key env and endpoint env', () => {
    expect(providerDefaults('anthropic')).toEqual({ envName: 'ANTHROPIC_API_KEY', endpointEnv: 'ANTHROPIC_BASE_URL', defaultEndpoint: 'https://api.anthropic.com' });
    expect(providerDefaults('google').endpointEnv).toBeNull();
    expect(PROVIDERS.map(p => p.id)).toContain('openrouter');
  });
});
