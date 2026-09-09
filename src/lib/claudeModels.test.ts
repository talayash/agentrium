import { describe, it, expect } from 'vitest';
import {
  CLAUDE_MODELS,
  CLAUDE_MODEL_FAMILIES,
  isClaudeModelAlias,
  modelsInFamily,
  getModelBadgeClasses,
  familyOfModel,
  familyLabel,
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

describe('resolved-version display (issue #65)', () => {
  // Byte-identical alias guard: enriching labels must NEVER change what we
  // send to `claude --model`. If this snapshot ever needs updating, the CLI
  // contract is being changed - not just the display.
  it('keeps every alias byte-identical to the pre-enrichment set', () => {
    expect(CLAUDE_MODELS.map(m => m.alias)).toEqual([
      'default',
      'fable',
      'opus',
      'opus[1m]',
      'opusplan',
      'sonnet',
      'sonnet[1m]',
      'haiku',
    ]);
  });

  it('pins resolvedVersion for family-alias entries so users see which sub-version they get', () => {
    const byAlias = (a: string) => CLAUDE_MODELS.find(m => m.alias === a)!;
    expect(byAlias('opus').resolvedVersion).toBe('4.7');
    expect(byAlias('sonnet').resolvedVersion).toBe('4.6');
    expect(byAlias('haiku').resolvedVersion).toBe('4.5');
    // Variants inherit the family's resolved version.
    expect(byAlias('opus[1m]').resolvedVersion).toBe('4.7');
    expect(byAlias('opusplan').resolvedVersion).toBe('4.7');
    expect(byAlias('sonnet[1m]').resolvedVersion).toBe('4.6');
  });

  it('leaves Default and Fable without a fixed version (their aliases don\'t map to one)', () => {
    const byAlias = (a: string) => CLAUDE_MODELS.find(m => m.alias === a)!;
    expect(byAlias('default').resolvedVersion).toBeUndefined();
    expect(byAlias('fable').resolvedVersion).toBeUndefined();
  });

  it('renders the base label with the version suffix so the family chip shows "Opus 4.7"', () => {
    const byAlias = (a: string) => CLAUDE_MODELS.find(m => m.alias === a)!;
    expect(byAlias('opus').label).toBe('Opus 4.7');
    expect(byAlias('sonnet').label).toBe('Sonnet 4.6');
    expect(byAlias('haiku').label).toBe('Haiku 4.5');
    // Base fullLabel matches label (no extra qualifier).
    expect(byAlias('opus').fullLabel).toBe('Opus 4.7');
    expect(byAlias('sonnet').fullLabel).toBe('Sonnet 4.6');
    expect(byAlias('haiku').fullLabel).toBe('Haiku 4.5');
  });

  it('keeps variant chip labels compact but includes the family+version in the tooltip fullLabel', () => {
    const byAlias = (a: string) => CLAUDE_MODELS.find(m => m.alias === a)!;
    // Variant chips sit under an already-versioned family chip, so the chip
    // itself stays short.
    expect(byAlias('opus[1m]').label).toBe('1M context');
    expect(byAlias('opusplan').label).toBe('Plan');
    expect(byAlias('sonnet[1m]').label).toBe('1M context');
    // fullLabel (title tooltip) gets the family+version so users see the
    // resolved version even when hovering a variant.
    expect(byAlias('opus[1m]').fullLabel).toBe('Opus 4.7 · 1M context');
    expect(byAlias('opusplan').fullLabel).toBe('Opus 4.7 · Plan');
    expect(byAlias('sonnet[1m]').fullLabel).toBe('Sonnet 4.6 · 1M context');
  });
});

describe('familyLabel', () => {
  it('returns the base entry label so the top-row family chip carries the version', () => {
    // Regression guard for the old `split(' ')[0]` behavior, which would
    // silently truncate "Opus 4.7" back to "Opus".
    expect(familyLabel('opus')).toBe('Opus 4.7');
    expect(familyLabel('sonnet')).toBe('Sonnet 4.6');
    expect(familyLabel('haiku')).toBe('Haiku 4.5');
    expect(familyLabel('fable')).toBe('Fable');
    expect(familyLabel('default')).toBe('Default');
  });
});
