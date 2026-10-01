import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock('../lib/handoff', () => ({ loadHandoffBrief: vi.fn(), buildHandoffBrief: vi.fn(() => 'Manual brief'), launchHandoff: vi.fn() }));
import { HandoffModal } from './HandoffModal';
import { loadHandoffBrief, launchHandoff } from '../lib/handoff';

beforeEach(() => {
  vi.mocked(loadHandoffBrief).mockResolvedValue('Original task');
  vi.mocked(launchHandoff).mockResolvedValue('new');
});
afterEach(cleanup);

it('sends the edited brief to the selected agent', async () => {
  const close = vi.fn();
  render(<HandoffModal sourceId="one" onClose={close} />);
  const input = await screen.findByDisplayValue('Original task');
  fireEvent.change(input, { target: { value: 'My decisions and next steps' } });
  fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open agent with brief' }));
  await waitFor(() => expect(launchHandoff).toHaveBeenCalledWith('one', 'codex', 'My decisions and next steps', 'same'));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
});

it('keeps edits and allows retry when the agent cannot launch', async () => {
  vi.mocked(launchHandoff).mockRejectedValue(new Error('Agent not installed'));
  const close = vi.fn();
  render(<HandoffModal sourceId="one" onClose={close} />);
  fireEvent.change(await screen.findByDisplayValue('Original task'), { target: { value: 'Keep these edits' } });
  fireEvent.click(screen.getByRole('button', { name: 'Open agent with brief' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Agent not installed');
  expect(screen.getByDisplayValue('Keep these edits')).toBeTruthy();
  expect(close).not.toHaveBeenCalled();
});

it('provides an editable fallback when changed files cannot be loaded', async () => {
  vi.mocked(loadHandoffBrief).mockRejectedValue(new Error('Git unavailable'));
  render(<HandoffModal sourceId="one" onClose={() => {}} />);
  expect(await screen.findByDisplayValue('Manual brief')).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toContain('complete the brief manually');
});
