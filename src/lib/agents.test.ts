import { describe, it, expect } from 'vitest';
import { AGENT_SPECS, specFor } from './agents';

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

  it('lists every agent kind exactly once', () => {
    const kinds = AGENT_SPECS.map(s => s.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds).toContain('claude');
    expect(kinds).toContain('codex');
    expect(kinds).toContain('cursor');
  });

  it('throws on unknown kind', () => {
    // @ts-expect-error - deliberately passing invalid kind
    expect(() => specFor('unknown')).toThrow();
  });
});
