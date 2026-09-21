import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import PrivacyPage from './PrivacyPage';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../../../lib/errorReporter', () => ({ reportInvokeFailure: vi.fn() }));
beforeEach(() => { cleanup(); vi.mocked(invoke).mockReset().mockResolvedValue(false); });
it('keeps external summaries off until consent is persisted by Rust', async () => {
  render(<PrivacyPage />);
  const toggle = screen.getByRole('switch', { name: 'External AI summaries' });
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('get_summary_enabled'));
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  fireEvent.click(toggle);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_summary_enabled', { enabled: true }));
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
});
it('keeps the preference off if persisting consent fails', async () => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === 'set_summary_enabled') throw new Error('disk failed');
    return false as never;
  });
  render(<PrivacyPage />);
  const toggle = screen.getByRole('switch', { name: 'External AI summaries' });
  fireEvent.click(toggle);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_summary_enabled', { enabled: true }));
  expect(toggle.getAttribute('aria-checked')).toBe('false');
});
