import { describe, it, expect } from 'vitest';
import {
  CLAUDE_MODELS,
  CLAUDE_MODEL_FAMILIES,
  isClaudeModelAlias,
  modelsInFamily,
  getModelBadgeClasses,
  familyOfModel,
} from './claudeModels';

describe('claudeModels catalog', () => {
  it('surfaces every family expected by the picker', () => {
    // Regression guard: if a family is dropped, the top-row family picker
    // silently loses a button and users can't reach the variants.
    expect(CLAUDE_MODEL_FAMILIES).toEqual(['default', 'fable', 'opus', 'sonnet', 'haiku']);
  });

  it('includes the 1M-context and opusplan aliases requested in issue #53', () => {
    const aliases = CLAUDE_MODELS.map(m => m.alias);
    expect(aliases).toContain('fable');
    expect(aliases).toContain('opus[1m]');
    expect(aliases).toContain('sonnet[1m]');
    expect(aliases).toContain('opusplan');
  });

  it('has no duplicate aliases', () => {
    const aliases = CLAUDE_MODELS.map(m => m.alias);
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it('groups variants under their family', () => {
    expect(modelsInFamily('opus').map(m => m.alias)).toEqual(['opus', 'opus[1m]', 'opusplan']);
    expect(modelsInFamily('sonnet').map(m => m.alias)).toEqual(['sonnet', 'sonnet[1m]']);
    expect(modelsInFamily('haiku').map(m => m.alias)).toEqual(['haiku']);
    expect(modelsInFamily('fable').map(m => m.alias)).toEqual(['fable']);
  });
});

describe('isClaudeModelAlias', () => {
  it('accepts bracketed variants (the exact string the CLI takes)', () => {
    expect(isClaudeModelAlias('sonnet[1m]')).toBe(true);
    expect(isClaudeModelAlias('opus[1m]')).toBe(true);
  });

  it('accepts bare aliases', () => {
    expect(isClaudeModelAlias('opus')).toBe(true);
    expect(isClaudeModelAlias('haiku')).toBe(true);
    expect(isClaudeModelAlias('opusplan')).toBe(true);
    expect(isClaudeModelAlias('fable')).toBe(true);
  });

  it('rejects arbitrary bracketed strings so the metacharacter check still catches injection attempts', () => {
    expect(isClaudeModelAlias('sonnet[$(rm)]')).toBe(false);
    expect(isClaudeModelAlias('opus[2m]')).toBe(false);
    expect(isClaudeModelAlias('random[thing]')).toBe(false);
  });
});

describe('getModelBadgeClasses', () => {
  it('returns the family badge classes for known aliases', () => {
    // Same family shares badge colors - variants shouldn't visually diverge
    // from their base model in the tab strip.
    expect(getModelBadgeClasses('opus')).toBe(getModelBadgeClasses('opus[1m]'));
    expect(getModelBadgeClasses('sonnet')).toBe(getModelBadgeClasses('sonnet[1m]'));
  });

  it('falls back to a neutral class for unknown aliases so removed models still render', () => {
    expect(getModelBadgeClasses('legacy-model-xyz')).toBe('bg-fill-hover text-text-tertiary');
    expect(getModelBadgeClasses(undefined)).toBe('bg-fill-hover text-text-tertiary');
  });
});

describe('familyOfModel', () => {
  it('maps variants back to their family so the picker can hydrate', () => {
    expect(familyOfModel('opus[1m]')).toBe('opus');
    expect(familyOfModel('opusplan')).toBe('opus');
    expect(familyOfModel('sonnet[1m]')).toBe('sonnet');
    expect(familyOfModel('fable')).toBe('fable');
  });

  it('returns "default" for undefined or unknown', () => {
    expect(familyOfModel(undefined)).toBe('default');
    expect(familyOfModel('unknown-alias')).toBe('default');
  });
});
