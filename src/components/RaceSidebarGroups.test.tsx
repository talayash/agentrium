import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { RaceSidebarGroups } from './RaceSidebarGroups';
import { useRaceStore } from '../store/raceStore';
import { useAppStore } from '../store/appStore';
import type { Race } from '../lib/races';

const race: Race = {
  id: 'r1', title: 'Performance Issue', prompt: 'p', repoPath: '/repo', baseBranch: 'main', baseSha: 'a',
  createdAt: '2026-10-03T00:00:00Z', status: 'running', winnerTask: null, decidedAt: null, checkCommand: null,
  contenders: [{
    idx: 0, agent: 'claude', model: 'opus', args: [], label: 'Claude Code · opus', branch: 'b', worktreePath: '/wt/0',
    terminalId: null, startedAt: null, finishedAt: null, outcome: 'pending', stats: null,
  }],
};

beforeEach(() => {
  useAppStore.setState({ openFiles: [], activeFilePath: null });
  useRaceStore.setState({ races: { r1: race } });
});
afterEach(cleanup);

it('opens the race tab when the group header is clicked', () => {
  render(<RaceSidebarGroups />);
  fireEvent.click(screen.getByRole('button', { name: 'Open race Performance Issue' }));
  expect(useAppStore.getState().activeFilePath).toBe('race:r1');
  expect(useAppStore.getState().openFiles[0]).toMatchObject({ path: 'race:r1', mode: 'race', content: 'Performance Issue' });
});
