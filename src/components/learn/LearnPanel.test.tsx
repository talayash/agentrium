import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { LearnPanel } from './LearnPanel';
import { useLearnStore } from '../../store/learnStore';
import { useTerminalStore } from '../../store/terminalStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../../lib/errorReporter', () => ({ reportInvokeFailure: vi.fn() }));

afterEach(cleanup);
beforeEach(() => {
  vi.mocked(invoke).mockReset().mockResolvedValue([] as never);
  useLearnStore.setState({ byTerminal: {} });
  useTerminalStore.setState({ activeTerminalId: 't1' } as never);
});

it('asks for consent and generates after Allow', async () => {
  useLearnStore.setState({ byTerminal: { t1: { status: 'no_consent', cards: [], unseen: 0 } } });
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    if (cmd === 'generate_learn_cards') return { status: 'no_changes', cards: [] } as never;
    return [] as never;
  });
  render(<LearnPanel />);
  fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_learn_consent', { enabled: true }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('generate_learn_cards', expect.objectContaining({ terminalId: 't1' })));
});

it('shows the status message when there is nothing to learn', () => {
  useLearnStore.setState({ byTerminal: { t1: { status: 'no_changes', cards: [], unseen: 0 } } });
  render(<LearnPanel />);
  expect(screen.getByText('No changes to learn from yet. Run an agent, then try again.')).toBeTruthy();
});

it('renders cards and clears the unseen badge', () => {
  useLearnStore.setState({ byTerminal: { t1: { status: 'ok', unseen: 2, cards: [{
    id: 'a', terminalId: 't1', createdAt: '', kind: 'syntax', title: 'Generics carry the type',
    filePath: 'a.ts', startLine: 1, endLine: 1, quote: ['x'], highlight: [1], why: ['b', 'i', 'e'],
    question: 'q?', options: ['1', '2', '3'], answerIndex: 0, explain: 'e', saved: false, answeredIndex: null,
  }] } } });
  render(<LearnPanel />);
  expect(screen.getByText('Generics carry the type')).toBeTruthy();
  expect(useLearnStore.getState().byTerminal.t1.unseen).toBe(0);
});

it('has a manual generate button', async () => {
  render(<LearnPanel />);
  fireEvent.click(screen.getByRole('button', { name: 'Learn from current changes' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('generate_learn_cards', expect.objectContaining({ terminalId: 't1' })));
});
