import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue([]) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
import { NewRaceModal } from './NewRaceModal';
import { useAppStore } from '../store/appStore';

beforeEach(() => useAppStore.setState({ newRaceModalOpen: true, newRaceRepoPath: null, newRacePrompt: null }));
afterEach(cleanup);

it('keeps the form open on a click outside or Escape; only Cancel and X close it', () => {
  render(<NewRaceModal />);
  fireEvent.change(screen.getByPlaceholderText(/Fix the login redirect loop/), { target: { value: 'Keep me' } });
  const dialog = screen.getByRole('dialog');
  fireEvent.click(dialog.parentElement!);
  fireEvent.doubleClick(dialog.parentElement!);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(useAppStore.getState().newRaceModalOpen).toBe(true);
  expect((screen.getByPlaceholderText(/Fix the login redirect loop/) as HTMLInputElement).value).toBe('Keep me');

  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(useAppStore.getState().newRaceModalOpen).toBe(false);
});

it('closes from the header X', () => {
  render(<NewRaceModal />);
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(useAppStore.getState().newRaceModalOpen).toBe(false);
});
