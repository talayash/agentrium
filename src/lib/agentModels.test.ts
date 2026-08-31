import { describe, it, expect } from 'vitest';
import {
  AGENT_MODELS,
  modelsForAgent,
  getAnyModelBadgeClasses,
  getModelBadgeLabel,
} from './agentModels';

describe('agentModels catalog', () => {
  it('covers every non-Claude agent', () => {
    expect(Object.keys(AGENT_MODELS).sort()).toEqual(['antigravity', 'codex', 'cursor']);
  });

  it('has no duplicate aliases within an agent', () => {
    for (const [agent, models] of Object.entries(AGENT_MODELS)) {
      const aliases = models.map(m => m.alias);
      expect(new Set(aliases).size, `duplicates in ${agent}`).toBe(aliases.length);
    }
  });

  it('uses CLI-safe aliases (no shell metacharacters, no spaces)', () => {
    // These aliases are injected straight into spawn args; they must never
    // trip the modal's dangerous-character validation or need quoting.
    for (const models of Object.values(AGENT_MODELS)) {
      for (const m of models) {
        expect(m.alias).toMatch(/^[a-z0-9.-]+$/);
      }
    }
  });

  it('gives every model badge and ring classes', () => {
    for (const models of Object.values(AGENT_MODELS)) {
      for (const m of models) {
        expect(m.badgeClasses).toContain('bg-');
        expect(m.ringClasses).toContain('ring-');
      }
    }
  });
});

describe('modelsForAgent', () => {
  it('returns an empty list for Claude (its picker uses claudeModels.ts)', () => {
    expect(modelsForAgent('claude')).toEqual([]);
  });

  it('returns the catalog list for other agents', () => {
    expect(modelsForAgent('codex')).toBe(AGENT_MODELS.codex);
    expect(modelsForAgent('cursor')).toBe(AGENT_MODELS.cursor);
    expect(modelsForAgent('antigravity')).toBe(AGENT_MODELS.antigravity);
  });
});

describe('getAnyModelBadgeClasses', () => {
  it('resolves Claude aliases via the Claude catalog', () => {
    expect(getAnyModelBadgeClasses('opus')).toContain('purple');
    expect(getAnyModelBadgeClasses('sonnet[1m]')).toContain('blue');
  });

  it('resolves agent catalog aliases', () => {
    expect(getAnyModelBadgeClasses('gpt-5.6-sol')).toContain('teal');
    expect(getAnyModelBadgeClasses('composer-2.5')).toContain('orange');
    expect(getAnyModelBadgeClasses('gemini-3.1-pro-high')).toContain('sky');
  });

  it('falls back to a muted style for unknown or missing aliases', () => {
    expect(getAnyModelBadgeClasses('some-future-model')).toContain('text-text-tertiary');
    expect(getAnyModelBadgeClasses(undefined)).toContain('text-text-tertiary');
  });
});

describe('getModelBadgeLabel', () => {
  it('shortens known long agent ids', () => {
    expect(getModelBadgeLabel('claude-opus-5-thinking-high')).toBe('Opus 5');
    expect(getModelBadgeLabel('gpt-oss-120b-medium')).toBe('GPT-OSS 120B');
  });

  it('passes Claude aliases and unknown ids through unchanged', () => {
    expect(getModelBadgeLabel('opus')).toBe('opus');
    expect(getModelBadgeLabel('some-future-model')).toBe('some-future-model');
  });
});
