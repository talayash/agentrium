import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listAgentSessions } from './agentSessions';
import { historyPathKey, loadHistoryGroups, type HistoryProfile } from './historyGroups';

vi.mock('./agentSessions', () => ({ listAgentSessions: vi.fn() }));
const list = vi.mocked(listAgentSessions);
const profile: HistoryProfile = { id: 'p', name: 'Reports', working_directory: 'C:\\Reports', agent: 'claude', claude_args: [], env_vars: {} };
const session = (n: number) => ({ id: `s${n}`, modified_at: `2026-09-${String(n).padStart(2, '0')}T12:00:00Z`, preview: `Session ${n}` });

beforeEach(() => { list.mockReset(); list.mockResolvedValue([]); });

describe('profile and folder history', () => {
  it('keeps five newest per profile and shares queries for equivalent paths', async () => {
    list.mockResolvedValue([1, 7, 2, 6, 3, 5, 4].map(session));
    const groups = await loadHistoryGroups([profile, { ...profile, id: 'p2', working_directory: 'c:/reports/' }], []);
    expect(groups).toHaveLength(2);
    expect(groups[0].sessions.map(s => s.id)).toEqual(['s7', 's6', 's5', 's4', 's3']);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('merges agents under folders, deduplicates Windows paths, and orders folders by activity', async () => {
    list.mockImplementation(async (agent, cwd) => agent === 'claude' ? [session(cwd === '/new' ? 9 : 2)] : agent === 'codex' ? [session(3)] : []);
    const groups = await loadHistoryGroups([], ['C:\\Reports', 'c:/reports/', '/new']);
    expect(groups.map(g => g.cwd)).toEqual(['/new', 'C:\\Reports']);
    expect(groups[1].sessions.map(s => s.agent)).toEqual(['codex', 'claude']);
    expect(list).toHaveBeenCalledTimes(6);
  });

  it('omits profile-covered agent sessions but retains other agents in the same folder', async () => {
    list.mockImplementation(async agent => agent === 'cursor' ? [] : [session(1)]);
    const groups = await loadHistoryGroups([profile], ['c:/reports']);
    expect(groups[0].sessions[0].agent).toBe('claude');
    expect(groups[1].sessions.map(s => s.agent)).toEqual(['codex']);
  });

  it('caps folder sessions at five across all agents', async () => {
    list.mockResolvedValue([1, 2, 3, 4, 5, 6].map(session));
    const groups = await loadHistoryGroups([], ['/reports']);
    expect(groups[0].sessions).toHaveLength(5);
    expect(groups[0].sessions[0].id).toBe('s6');
  });

  it('isolates failures and hides empty or unsupported profiles', async () => {
    list.mockImplementation(async agent => {
      if (agent === 'codex') throw new Error('Unavailable');
      return agent === 'claude' ? [] : [session(1)];
    });
    const groups = await loadHistoryGroups([profile, { ...profile, id: 'agy', agent: 'antigravity' }], ['/other']);
    expect(groups).toHaveLength(1);
    expect(groups[0].profile).toBeUndefined();
    expect(groups[0].error).toBeTruthy();
    expect(groups[0].sessions[0].agent).toBe('cursor');
  });

  it('preserves case for POSIX paths and handles UNC paths', () => {
    expect(historyPathKey('/Work')).not.toBe(historyPathKey('/work'));
    expect(historyPathKey('\\\\Server\\Share\\')).toBe('//server/share');
  });

  it('keeps failed profile lookups visible and shares the failure for matching profiles', async () => {
    list.mockRejectedValue(new Error('Cannot read session index'));
    const groups = await loadHistoryGroups([profile, { ...profile, id: 'second' }], []);
    expect(groups).toHaveLength(2);
    expect(groups.every(g => g.error?.includes('Cannot read session index'))).toBe(true);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('does not scan more folders after the request becomes stale', async () => {
    let current = true;
    list.mockImplementation(async () => { current = false; return [session(1)]; });
    expect(await loadHistoryGroups([], ['/first', '/second'], () => current)).toEqual([]);
    expect(list.mock.calls.every(([, cwd]) => cwd === '/first')).toBe(true);
  });

  it('deduplicates a session within its agent but preserves the same ID from another agent', async () => {
    list.mockImplementation(async agent => agent === 'cursor' ? [] : [session(1), session(1)]);
    const groups = await loadHistoryGroups([], ['/work']);
    expect(groups[0].sessions.map(s => [s.agent, s.id])).toEqual([['claude', 's1'], ['codex', 's1']]);
  });
});
