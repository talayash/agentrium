import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn(
  async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => undefined,
);
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

import type { TerminalConfig } from './terminalStore';
import { useTerminalStore } from './terminalStore';

function makeConfig(id: string, overrides: Partial<TerminalConfig> = {}): TerminalConfig {
  return {
    id,
    label: id,
    nickname: null,
    profile_id: null,
    working_directory: 'C:/tmp',
    claude_args: [],
    env_vars: {},
    created_at: '2026-01-01T00:00:00Z',
    status: 'Running',
    color_tag: null,
    ...overrides,
  };
}

function seed(ids: string[], activeId: string | null = null) {
  const terminals = new Map(
    ids.map((id) => [
      id,
      {
        config: makeConfig(id),
        xterm: null,
        isWorktree: false,
      },
    ])
  );
  useTerminalStore.setState({
    terminals,
    activeTerminalId: activeId ?? ids[0] ?? null,
    unreadTerminalIds: new Set(),
    gitInfoCache: new Map(),
    scriptChildren: new Map(),
    bottomTerminalIds: [],
    activeBottomTerminalId: null,
  });
}

describe('terminalStore - unread set', () => {
  beforeEach(() => {
    seed([]);
  });

  it('handleTerminalOutput marks an inactive terminal as unread', () => {
    seed(['a', 'b'], 'a');

    useTerminalStore.getState().handleTerminalOutput('b', new Uint8Array([0x68]));

    expect(useTerminalStore.getState().unreadTerminalIds.has('b')).toBe(true);
    expect(useTerminalStore.getState().unreadTerminalIds.has('a')).toBe(false);
  });

  it('does not mark the active terminal as unread', () => {
    seed(['a', 'b'], 'a');

    useTerminalStore.getState().handleTerminalOutput('a', new Uint8Array([0x68]));

    expect(useTerminalStore.getState().unreadTerminalIds.has('a')).toBe(false);
  });

  it('short-circuits when the terminal is already marked unread (preserves Set identity)', () => {
    seed(['a', 'b'], 'a');
    useTerminalStore.setState({ unreadTerminalIds: new Set(['b']) });
    const before = useTerminalStore.getState().unreadTerminalIds;

    useTerminalStore.getState().handleTerminalOutput('b', new Uint8Array([0x69]));

    // The hot path skips set() entirely, so the Set reference must be identical
    // - that's the whole point of the short-circuit added for streaming perf.
    expect(useTerminalStore.getState().unreadTerminalIds).toBe(before);
  });

  it('writes received bytes to xterm when one is attached', () => {
    seed(['a'], 'a');
    const write = vi.fn();
    useTerminalStore.setState((state) => {
      const next = new Map(state.terminals);
      const inst = next.get('a')!;
      next.set('a', { ...inst, xterm: { write } as unknown as NonNullable<typeof inst.xterm> });
      return { terminals: next };
    });
    const bytes = new Uint8Array([1, 2, 3]);

    useTerminalStore.getState().handleTerminalOutput('a', bytes);

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(bytes);
  });

  it('setActiveTerminal clears that id from the unread set', () => {
    seed(['a', 'b'], 'a');
    useTerminalStore.setState({ unreadTerminalIds: new Set(['b']) });

    useTerminalStore.getState().setActiveTerminal('b');

    const state = useTerminalStore.getState();
    expect(state.activeTerminalId).toBe('b');
    expect(state.unreadTerminalIds.has('b')).toBe(false);
  });

  it('clearUnread / hasUnread agree', () => {
    seed(['a']);
    useTerminalStore.setState({ unreadTerminalIds: new Set(['a']) });

    expect(useTerminalStore.getState().hasUnread('a')).toBe(true);
    useTerminalStore.getState().clearUnread('a');
    expect(useTerminalStore.getState().hasUnread('a')).toBe(false);
  });
});

describe('terminalStore - reorderTerminals', () => {
  it('reorders known ids in the requested order', () => {
    seed(['a', 'b', 'c']);

    useTerminalStore.getState().reorderTerminals(['c', 'a', 'b']);

    const ids = Array.from(useTerminalStore.getState().terminals.keys());
    expect(ids).toEqual(['c', 'a', 'b']);
  });

  it('drops unknown ids passed in the order argument', () => {
    seed(['a', 'b']);

    useTerminalStore.getState().reorderTerminals(['ghost', 'b', 'a']);

    const ids = Array.from(useTerminalStore.getState().terminals.keys());
    expect(ids).toEqual(['b', 'a']);
  });

  it('appends ids that were missing from the order argument', () => {
    seed(['a', 'b', 'c']);

    useTerminalStore.getState().reorderTerminals(['c']);

    const ids = Array.from(useTerminalStore.getState().terminals.keys());
    expect(ids[0]).toBe('c');
    expect(ids.slice(1).sort()).toEqual(['a', 'b']);
    expect(ids).toHaveLength(3);
  });

  it('preserves instance identity (does not clone TerminalInstance objects)', () => {
    seed(['a', 'b']);
    const before = useTerminalStore.getState().terminals.get('a');

    useTerminalStore.getState().reorderTerminals(['b', 'a']);

    const after = useTerminalStore.getState().terminals.get('a');
    expect(after).toBe(before);
  });
});

describe('terminalStore - per-terminal mutators', () => {
  beforeEach(() => seed(['a', 'b']));

  it('updateTerminalStatus mutates only the targeted instance', () => {
    useTerminalStore.getState().updateTerminalStatus('a', 'Idle');

    expect(useTerminalStore.getState().terminals.get('a')!.config.status).toBe('Idle');
    expect(useTerminalStore.getState().terminals.get('b')!.config.status).toBe('Running');
  });

  it('setLoopMode stores and clears loop info', () => {
    useTerminalStore.getState().setLoopMode('a', { interval: '5m', prompt: '/foo' });
    expect(useTerminalStore.getState().terminals.get('a')!.loopInfo).toEqual({
      interval: '5m',
      prompt: '/foo',
    });

    useTerminalStore.getState().setLoopMode('a', null);
    expect(useTerminalStore.getState().terminals.get('a')!.loopInfo).toBeNull();
  });

  it('setSessionSummary stores and clears the summary', () => {
    useTerminalStore.getState().setSessionSummary('b', 'wrote tests');
    expect(useTerminalStore.getState().terminals.get('b')!.sessionSummary).toBe('wrote tests');

    useTerminalStore.getState().setSessionSummary('b', null);
    expect(useTerminalStore.getState().terminals.get('b')!.sessionSummary).toBeNull();
  });

  it('mutators on unknown ids are silent no-ops', () => {
    expect(() => {
      useTerminalStore.getState().updateTerminalStatus('ghost', 'Error');
      useTerminalStore.getState().setLoopMode('ghost', null);
      useTerminalStore.getState().setSessionSummary('ghost', 'x');
    }).not.toThrow();
  });

  it('getTerminalList returns one TerminalConfig per instance', () => {
    const list = useTerminalStore.getState().getTerminalList();
    expect(list.map((c) => c.id).sort()).toEqual(['a', 'b']);
  });
});

describe('terminalStore - writeToTerminal chunking', () => {
  beforeEach(() => {
    seed(['a']);
    invokeMock.mockClear();
  });

  it('sends a small write as a single invoke call', async () => {
    await useTerminalStore.getState().writeToTerminal('a', 'hello');

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = invokeMock.mock.calls[0]!;
    expect(cmd).toBe('write_to_terminal');
    expect((args as { id: string; data: number[] }).id).toBe('a');
    expect((args as { id: string; data: number[] }).data).toEqual([0x68, 0x65, 0x6c, 0x6c, 0x6f]);
  });

  it('chunks a paste larger than 60 KB into multiple sequential writes', async () => {
    // 200 KB of ASCII forces 4 chunks under the 60 KB cap (60 + 60 + 60 + 20).
    const big = 'x'.repeat(200 * 1024);
    await useTerminalStore.getState().writeToTerminal('a', big);

    expect(invokeMock).toHaveBeenCalledTimes(4);
    const dataLengths = invokeMock.mock.calls.map(
      (call) => (call[1] as { data: number[] }).data.length,
    );
    expect(dataLengths.reduce((n, len) => n + len, 0)).toBe(big.length);
    expect(dataLengths.every((len) => len <= 60 * 1024)).toBe(true);
  });
});

describe('terminalStore session state', () => {
  beforeEach(() => {
    useTerminalStore.setState({ terminalStates: new Map() });
  });

  it('setTerminalState stores a state', () => {
    useTerminalStore.getState().setTerminalState('a', 'waiting');
    expect(useTerminalStore.getState().terminalStates.get('a')).toBe('waiting');
  });

  it('setTerminalState is a no-op (same map reference) when unchanged', () => {
    useTerminalStore.getState().setTerminalState('a', 'busy');
    const before = useTerminalStore.getState().terminalStates;
    useTerminalStore.getState().setTerminalState('a', 'busy');
    expect(useTerminalStore.getState().terminalStates).toBe(before);
  });

  it('setTerminalState replaces the map when the value changes', () => {
    useTerminalStore.getState().setTerminalState('a', 'busy');
    const before = useTerminalStore.getState().terminalStates;
    useTerminalStore.getState().setTerminalState('a', 'idle');
    expect(useTerminalStore.getState().terminalStates).not.toBe(before);
    expect(useTerminalStore.getState().terminalStates.get('a')).toBe('idle');
  });
});
