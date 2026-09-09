import { describe, it, expect } from 'vitest';
import { AGENT_SPECS, filterArgsForAgent, specFor } from './agents';
import { isCustomAgent, customKind, setCustomAgentSpecs, allAgentSpecs, defaultArgsFor } from './agents';

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

describe('custom agent kinds', () => {
  const oc = {
    kind: customKind('a1'),
    displayName: 'OpenCode',
    binary: 'opencode',
    installUrl: 'https://opencode.ai',
    installHint: 'npm i -g opencode-ai',
    defaultArgsHint: '',
    color: '#30C55E',
    monogram: 'OC',
    defaultArgs: ['--agent', 'build'],
    resumeFlag: '--session {id}',
    requiredEnv: ['OPENAI_API_KEY'],
  };

  it('customKind builds the wire form and isCustomAgent detects it', () => {
    expect(customKind('a1')).toBe('custom:a1');
    expect(isCustomAgent('custom:a1')).toBe(true);
    expect(isCustomAgent('claude')).toBe(false);
  });

  it('specFor resolves a registered custom spec and allAgentSpecs appends it after built-ins', () => {
    setCustomAgentSpecs([oc]);
    expect(specFor('custom:a1').binary).toBe('opencode');
    const kinds = allAgentSpecs().map(s => s.kind);
    expect(kinds.slice(0, 4)).toEqual(['claude', 'codex', 'cursor', 'antigravity']);
    expect(kinds[4]).toBe('custom:a1');
    setCustomAgentSpecs([]);
    expect(() => specFor('custom:a1')).toThrow();
  });

  it('filterArgsForAgent treats custom kinds like cursor', () => {
    const out = filterArgsForAgent('custom:a1', ['--dangerously-skip-permissions', '--model', 'opus', '--verbose']);
    expect(out).toEqual(['--verbose']);
  });

  it('defaultArgsFor returns the custom agent default args, else the builtin map entry', () => {
    setCustomAgentSpecs([oc]);
    expect(defaultArgsFor('custom:a1', { claude: ['--x'], codex: [], cursor: [], antigravity: [] })).toEqual(['--agent', 'build']);
    expect(defaultArgsFor('claude', { claude: ['--x'], codex: [], cursor: [], antigravity: [] })).toEqual(['--x']);
    setCustomAgentSpecs([]);
  });
});
