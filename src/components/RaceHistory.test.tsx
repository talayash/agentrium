import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../lib/confirmDialog', () => ({ confirmAction: vi.fn().mockResolvedValue(true) }));
import { invoke } from '@tauri-apps/api/core';
import { RaceHistory } from './RaceHistory';
import { useRaceStore } from '../store/raceStore';
import { useAppStore } from '../store/appStore';
import type { Race, RaceContender } from '../lib/races';

const c = (idx: number, label: string, outcome: string, agent: 'claude' | 'codex'): RaceContender => ({
  idx, agent, model: null, args: [], label, branch: `b${idx}`, worktreePath: `/wt/${idx}`, terminalId: null,
  startedAt: null, finishedAt: null, outcome,
  stats: { elapsedMs: 90_000, costUsd: 0.5, tokens: 100, filesChanged: 3, added: 12, removed: 4, check: 'pass' },
});
const decided: Race = {
  id: 'r1', title: 'Fix login', prompt: 'p', repoPath: '/repo', baseBranch: 'main', baseSha: 'a', createdAt: '2026-10-01T00:00:00Z',
  status: 'decided', winnerTask: '/wt/1', decidedAt: '2026-10-01T01:00:00Z', checkCommand: null,
  contenders: [c(0, 'Claude Code', 'discarded', 'claude'), c(1, 'Codex', 'winner', 'codex')],
};

beforeEach(() => {
  useAppStore.setState({ openFiles: [], activeFilePath: null });
  useRaceStore.setState({ races: {
    r1: decided,
    r2: { ...decided, id: 'r2', title: 'Still running', status: 'running', winnerTask: null, decidedAt: null },
    r3: { ...decided, id: 'r3', title: 'Gave up', status: 'abandoned', winnerTask: null, decidedAt: '2026-09-30T00:00:00Z' },
  } });
});
afterEach(cleanup);

it('lists finished races with the winner and its stats, plus win rates, and opens the compare tab', () => {
  render(<RaceHistory />);
  expect(screen.queryByText('Still running')).toBeNull();
  expect(screen.getByText('Gave up')).toBeTruthy();
  expect(screen.getByText(/Abandoned · 2 contenders/)).toBeTruthy();
  expect(screen.getByText('1m 30s · $0.50 · 3f', { exact: false })).toBeTruthy();
  expect(screen.getByTitle('Codex: won 1 of 1 decided race(s)').textContent).toBe('Codex 100%');
  expect(screen.getByTitle('Claude Code: won 0 of 1 decided race(s)').textContent).toBe('Claude Code 0%');
  fireEvent.click(screen.getByText('Fix login'));
  expect(useAppStore.getState().activeFilePath).toBe('race:r1');
  expect(useAppStore.getState().openFiles[0]).toMatchObject({ path: 'race:r1', mode: 'race', content: 'Fix login' });
});

it('renders nothing without finished races', () => {
  useRaceStore.setState({ races: {} });
  const { container } = render(<RaceHistory />);
  expect(container.innerHTML).toBe('');
});

it('deletes a finished race from history and closes its tab', async () => {
  vi.mocked(invoke).mockResolvedValue(undefined);
  useAppStore.getState().openRaceTab('r1', 'Fix login');
  render(<RaceHistory />);
  fireEvent.click(screen.getByRole('button', { name: 'Delete race Fix login' }));
  await waitFor(() => expect(useRaceStore.getState().races.r1).toBeUndefined());
  expect(invoke).toHaveBeenCalledWith('delete_race', { raceId: 'r1' });
  expect(useAppStore.getState().openFiles.some((t) => t.path === 'race:r1')).toBe(false);
  expect(screen.queryByText('Fix login')).toBeNull();
});
