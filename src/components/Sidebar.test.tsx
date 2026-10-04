import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
// The navigator bodies are covered by their own tests; stub them so this file
// only exercises the sidebar chrome.
vi.mock('./FileTreePanel', () => ({ FileTreePanel: () => null }));
vi.mock('./SessionsPanel', () => ({ SessionsPanel: () => null }));
vi.mock('./SessionCards', () => ({ SessionCards: () => null }));
vi.mock('./RaceSidebarGroups', () => ({ RaceSidebarGroups: () => null }));
vi.mock('./RaceHistory', () => ({ RaceHistory: () => null }));
import { Sidebar } from './Sidebar';
import { useAppStore } from '../store/appStore';

beforeEach(() => {
  useAppStore.setState({ sidebarNav: 'sessions', profileModalOpen: false, editingProfileId: null });
});
afterEach(cleanup);

it('opens the profile manager (not a focused editor) from the expanded sidebar', () => {
  useAppStore.setState({ sidebarCollapsed: false });
  render(<Sidebar />);
  fireEvent.click(screen.getByRole('button', { name: 'Profiles' }));
  expect(useAppStore.getState().profileModalOpen).toBe(true);
  expect(useAppStore.getState().editingProfileId).toBeNull();
});

it('opens the profile manager from the collapsed rail', () => {
  useAppStore.setState({ sidebarCollapsed: true });
  render(<Sidebar />);
  fireEvent.click(screen.getByRole('button', { name: 'Profiles' }));
  expect(useAppStore.getState().profileModalOpen).toBe(true);
  expect(useAppStore.getState().editingProfileId).toBeNull();
});

it('places Profiles directly above Settings', () => {
  useAppStore.setState({ sidebarCollapsed: false });
  render(<Sidebar />);
  const labels = screen.getAllByRole('button').map((b) => b.textContent?.trim());
  expect(labels.indexOf('Profiles')).toBe(labels.indexOf('Settings') - 1);
});

it('pairs Task with Race and Profiles with Settings, keeping full accessible names', () => {
  useAppStore.setState({ sidebarCollapsed: false });
  render(<Sidebar />);
  const task = screen.getByRole('button', { name: 'New Task' });
  expect(task.parentElement).toBe(screen.getByRole('button', { name: 'New Race' }).parentElement);
  const settings = screen.getAllByRole('button', { name: 'Settings' }).find((b) => b.textContent?.trim() === 'Settings');
  const profiles = screen.getAllByRole('button', { name: 'Profiles' }).find((b) => b.textContent?.trim() === 'Profiles');
  expect(profiles?.parentElement).toBe(settings?.parentElement);
});
