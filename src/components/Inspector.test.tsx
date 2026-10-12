import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Inspector } from './Inspector';
import { useAppStore } from '../store/appStore';
import { useLearnStore } from '../store/learnStore';
import { useTerminalStore } from '../store/terminalStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue([]) }));
vi.mock('./FileChangesPanel', () => ({ FileChangesPanel: () => <div>changes-panel</div> }));
vi.mock('./WorkspacesPanel', () => ({ WorkspacesPanel: () => <div>workspaces-panel</div> }));
vi.mock('./HintsPanel', () => ({ HintsPanel: () => <div>hints-panel</div> }));
vi.mock('./learn/LearnPanel', () => ({ LearnPanel: () => <div>learn-panel</div> }));

afterEach(cleanup);
beforeEach(() => {
  useAppStore.setState({ learnEnabled: true, learnOpen: false, changesOpen: true, workspacesOpen: false, hintsOpen: false });
  useLearnStore.setState({ byTerminal: {} });
  useTerminalStore.setState({ activeTerminalId: 't1' } as never);
});

it('shows a Learn tab that opens the Learn panel', () => {
  render(<Inspector />);
  fireEvent.click(screen.getByRole('button', { name: /Learn/ }));
  expect(screen.getByText('learn-panel')).toBeTruthy();
  expect(useAppStore.getState().changesOpen).toBe(false);
});

it('shows the unseen count on the Learn tab', () => {
  useLearnStore.setState({ byTerminal: { t1: { status: 'ok', cards: [], unseen: 3 } } });
  render(<Inspector />);
  expect(screen.getByRole('button', { name: /Learn/ }).textContent).toContain('3');
});

it('hides the Learn tab when the feature is off', () => {
  useAppStore.setState({ learnEnabled: false });
  render(<Inspector />);
  expect(screen.queryByRole('button', { name: /Learn/ })).toBeNull();
});
