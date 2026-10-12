import { beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import LearnPage from './LearnPage';
import { useAppStore } from '../../../store/appStore';
import { toast } from '../../../store/toastStore';
import { reportInvokeFailure } from '../../../lib/errorReporter';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../../../lib/errorReporter', () => ({ reportInvokeFailure: vi.fn() }));
vi.mock('../../../store/toastStore', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

beforeEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset().mockResolvedValue(false as never);
  vi.mocked(toast.error).mockReset();
  vi.mocked(reportInvokeFailure).mockReset();
  useAppStore.setState({ learnEnabled: true });
});

it('Learn is on by default and can be turned off', () => {
  render(<LearnPage />);
  const toggle = screen.getByRole('switch', { name: 'Learn from agent changes' });
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  fireEvent.click(toggle);
  expect(useAppStore.getState().learnEnabled).toBe(false);
});

it('consent is off until Rust persists it', async () => {
  render(<LearnPage />);
  const toggle = screen.getByRole('switch', { name: 'Allow Learn to send the session diff to Claude' });
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('get_learn_consent'));
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  fireEvent.click(toggle);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_learn_consent', { enabled: true }));
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
});

it('hydrates consent as on when Rust reports it is persisted', async () => {
  vi.mocked(invoke).mockImplementation(async (cmd) => (cmd === 'get_learn_consent' ? true : false) as never);
  render(<LearnPage />);
  const toggle = screen.getByRole('switch', { name: 'Allow Learn to send the session diff to Claude' });
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
});

it('keeps consent off and reports the error if persisting fails', async () => {
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    if (cmd === 'set_learn_consent') throw new Error('disk');
    return false as never;
  });
  render(<LearnPage />);
  const toggle = screen.getByRole('switch', { name: 'Allow Learn to send the session diff to Claude' });
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('get_learn_consent'));
  fireEvent.click(toggle);
  await waitFor(() => expect(reportInvokeFailure).toHaveBeenCalledWith('set_learn_consent', expect.anything()));
  expect(toast.error).toHaveBeenCalledWith('Could not change the Learn preference');
  expect(toggle.getAttribute('aria-checked')).toBe('false');
});
