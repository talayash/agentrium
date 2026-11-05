import { describe, it, expect } from 'vitest';
import { availableViewModes, nextViewMode, viewModeOf } from './viewMode';

describe('availableViewModes', () => {
  it('shell terminals are cli only', () => {
    expect(availableViewModes({ isShellTerminal: true, config: { agent: 'claude' } })).toEqual(['cli']);
  });
  it('script children are cli only', () => {
    expect(availableViewModes({ scriptParentId: 'p', config: { agent: 'claude' } })).toEqual(['cli']);
  });
  it('claude and codex get all three', () => {
    expect(availableViewModes({ config: { agent: 'claude' } })).toEqual(['cli', 'mixed', 'insight']);
    expect(availableViewModes({ config: { agent: 'codex' } })).toEqual(['cli', 'mixed', 'insight']);
  });
  it('cursor and custom agents get cli and mixed', () => {
    expect(availableViewModes({ config: { agent: 'cursor' } })).toEqual(['cli', 'mixed']);
    expect(availableViewModes({ config: { agent: 'custom:x' } })).toEqual(['cli', 'mixed']);
  });
});

describe('nextViewMode', () => {
  const all = ['cli', 'mixed', 'insight'] as const;
  it('cycles cli -> mixed -> insight -> cli', () => {
    expect(nextViewMode('cli', [...all])).toBe('mixed');
    expect(nextViewMode('mixed', [...all])).toBe('insight');
    expect(nextViewMode('insight', [...all])).toBe('cli');
  });
  it('skips unavailable modes', () => {
    expect(nextViewMode('mixed', ['cli', 'mixed'])).toBe('cli');
  });
});

describe('viewModeOf', () => {
  it('explicit view_mode wins', () => {
    expect(viewModeOf({ view_mode: 'insight', insight_layer: true })).toBe('insight');
    expect(viewModeOf({ view_mode: 'cli', insight_layer: true })).toBe('cli');
  });
  it('legacy insight_layer true maps to mixed', () => {
    expect(viewModeOf({ insight_layer: true })).toBe('mixed');
  });
  it('empty maps to cli', () => {
    expect(viewModeOf({})).toBe('cli');
  });
});
