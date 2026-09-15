import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { useTerminalStore, type TerminalConfig } from '../store/terminalStore';
import { captureSessionScreen, contextTooltip, refreshSessionContext, sessionDisplayName, type SessionContext } from './sessionContext';

const context: SessionContext = {
  title: 'Fix login redirect', goal: 'Keep users signed in.', latest: 'Checking restart behavior.',
  updatedAt: '2026-09-15T10:00:00Z', generated: true,
};
const config: TerminalConfig = {
  id: 'test', label: 'Agentrium 1', nickname: null, profile_id: null,
  working_directory: '/project', claude_args: [], env_vars: {},
  created_at: '', status: 'Running', color_tag: null, agent: 'codex',
};
const seed = () => useTerminalStore.setState({ terminals: new Map([
  ['test', { config: { ...config }, xterm: null, isWorktree: false }],
]) });

beforeEach(() => { invoke.mockReset(); seed(); });

describe('session context', () => {
  it('prefers a manual name and falls back through generated and default titles', () => {
    expect(sessionDisplayName({ config })).toBe('Agentrium 1');
    expect(sessionDisplayName({ config, sessionContext: context })).toBe('Fix login redirect');
    expect(sessionDisplayName({ config: { ...config, nickname: 'My task' }, sessionContext: context })).toBe('My task');
  });

  it('does not overwrite a rename made while generation is in flight', async () => {
    let resolve!: (value: SessionContext) => void;
    invoke.mockReturnValue(new Promise<SessionContext>(yes => { resolve = yes; }));
    const request = refreshSessionContext('test');
    const current = useTerminalStore.getState().terminals.get('test')!;
    useTerminalStore.setState({ terminals: new Map([['test', { ...current, config: { ...config, nickname: 'My task' } }]]) });
    resolve(context);
    await request;
    expect(sessionDisplayName(useTerminalStore.getState().terminals.get('test')!)).toBe('My task');
  });

  it('deduplicates requests and ignores a result after the terminal closes', async () => {
    let resolve!: (value: SessionContext) => void;
    invoke.mockReturnValue(new Promise<SessionContext>(yes => { resolve = yes; }));
    const request = refreshSessionContext('test');
    expect(refreshSessionContext('test')).toBe(request);
    useTerminalStore.setState({ terminals: new Map() });
    resolve(context);
    await request;
    expect(invoke).toHaveBeenCalledOnce();
    expect(useTerminalStore.getState().terminals.size).toBe(0);
  });

  it('loads saved context without sending screen content or starting generation', async () => {
    invoke.mockResolvedValue(context);
    await refreshSessionContext('test', false, true);
    expect(invoke).toHaveBeenCalledWith('get_terminal_context', { id: 'test', screen: null, regenerate: false });
    expect(useTerminalStore.getState().terminals.get('test')?.sessionContext).toEqual(context);
  });

  it('allows retry after failure and retains existing context when no result is available', async () => {
    useTerminalStore.getState().setSessionContext('test', context);
    invoke.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(null);
    await expect(refreshSessionContext('test')).rejects.toThrow('offline');
    await refreshSessionContext('test');
    expect(useTerminalStore.getState().terminals.get('test')?.sessionContext).toEqual(context);
  });

  it('bounds long scrollback while retaining its beginning and end', () => {
    const current = useTerminalStore.getState().terminals.get('test')!;
    const xterm = { buffer: { active: { length: 10000, getLine: (i: number) => ({ translateToString: () => `line ${i} ${'x'.repeat(250)}` }) } } } as unknown as Terminal;
    useTerminalStore.setState({ terminals: new Map([['test', { ...current, xterm }]]) });
    const screen = captureSessionScreen('test');
    expect(screen).toContain('line 0 ');
    expect(screen).toContain('line 9999 ');
    expect(screen.length).toBeLessThan(16000);
  });

  it('shows goal and latest separately and can expose a legacy summary', () => {
    expect(contextTooltip('Task', context)).toContain('Goal: Keep users signed in.\nLatest: Checking restart behavior.');
    expect(contextTooltip('Task', null, 'Existing summary')).toBe('Task\n\nExisting summary');
    expect(contextTooltip('Task', { ...context, latest: '' })).not.toContain('Latest:');
  });
});
