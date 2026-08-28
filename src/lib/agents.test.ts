import { describe, it, expect } from 'vitest';
import { AGENT_SPECS, filterArgsForAgent, specFor } from './agents';

describe('agents catalog', () => {
  it('resolves claude by kind', () => {
    expect(specFor('claude').binary).toBe('claude');
  });

  it('resolves codex by kind', () => {
    expect(specFor('codex').binary).toBe('codex');
  });

  it('resolves cursor by kind', () => {
    // Cursor CLI's binary is literally `agent` (per cursor.com/docs/cli),
    // NOT `cursor`. This test guards against future edits that "correct"
    // this to the intuitive-but-wrong `cursor`.
    expect(specFor('cursor').binary).toBe('agent');
  });

  it('resolves antigravity by kind', () => {
    // Antigravity CLI's binary is literally `agy` (per
    // antigravity.google/docs/cli), NOT `antigravity`. This test guards
    // against future edits that "correct" this to the intuitive-but-
    // wrong `antigravity`.
    expect(specFor('antigravity').binary).toBe('agy');
  });

  it('lists every agent kind exactly once', () => {
    const kinds = AGENT_SPECS.map(s => s.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds).toContain('claude');
    expect(kinds).toContain('codex');
    expect(kinds).toContain('cursor');
    expect(kinds).toContain('antigravity');
  });

  it('throws on unknown kind', () => {
    // @ts-expect-error - deliberately passing invalid kind
    expect(() => specFor('unknown')).toThrow();
  });
});

describe('filterArgsForAgent', () => {
  it('leaves args untouched when agent is claude', () => {
    const args = ['--model', 'opus', '--dangerously-skip-permissions', '--user-flag'];
    expect(filterArgsForAgent('claude', args)).toEqual(args);
  });

  it('returns a shallow copy for claude so callers can mutate safely', () => {
    const args = ['--verbose'];
    const out = filterArgsForAgent('claude', args);
    expect(out).not.toBe(args);
  });

  it('strips --dangerously-skip-permissions for codex', () => {
    expect(filterArgsForAgent('codex', ['--dangerously-skip-permissions', '--user-flag']))
      .toEqual(['--user-flag']);
  });

  it('strips --model and its value for cursor', () => {
    expect(filterArgsForAgent('cursor', ['--model', 'opus', '--user-flag']))
      .toEqual(['--user-flag']);
  });

  it('strips --effort and its value for codex', () => {
    expect(filterArgsForAgent('codex', ['--effort', 'high', '--user-flag']))
      .toEqual(['--user-flag']);
  });

  it('handles the --flag=value form', () => {
    expect(filterArgsForAgent('codex', ['--model=opus', '--user-flag']))
      .toEqual(['--user-flag']);
  });

  it('does not eat the next token when a --flag-with-value has an omitted value', () => {
    // Malformed input, but we still shouldn't drop --keep.
    expect(filterArgsForAgent('codex', ['--model', '--keep']))
      .toEqual(['--keep']);
  });

  it('strips multiple Claude-only flags in one pass for cursor', () => {
    // --continue is preserved for Cursor - it's a valid Cursor flag.
    expect(filterArgsForAgent('cursor', [
      '--dangerously-skip-permissions',
      '--model', 'opus',
      '--continue',
      '--user-flag',
      '--another',
    ])).toEqual(['--continue', '--user-flag', '--another']);
  });

  it('preserves --continue for cursor and antigravity but strips it for codex', () => {
    const args = ['--continue', '--dangerously-skip-permissions'];
    expect(filterArgsForAgent('codex', args)).toEqual([]);
    expect(filterArgsForAgent('cursor', args)).toEqual(['--continue']);
    expect(filterArgsForAgent('antigravity', args)).toEqual(['--continue']);
  });
});
