import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
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

it('keeps the footer to one row: New Session, then Profiles and Settings as icons', () => {
  useAppStore.setState({ sidebarCollapsed: false });
  render(<Sidebar />);
  const newSession = screen.getByRole('button', { name: /New Session/ });
  const profiles = screen.getByRole('button', { name: 'Profiles' });
  const settings = screen.getByRole('button', { name: 'Settings' });
  // Icon-only, but still named for screen readers.
  expect(profiles.textContent?.trim()).toBe('');
  expect(settings.textContent?.trim()).toBe('');
  const footer = newSession.closest('.p-2');
  expect(footer?.contains(profiles) && footer?.contains(settings)).toBe(true);
  // Task and Race are not on screen until the menu opens.
  expect(screen.queryByRole('menuitem', { name: 'New Task' })).toBeNull();
});

it('opens Task and Race from the New Session menu and closes it after picking', () => {
  const original = useAppStore.getState();
  const openNewTaskModal = vi.fn();
  const openNewRaceModal = vi.fn();
  useAppStore.setState({ sidebarCollapsed: false, openNewTaskModal, openNewRaceModal });
  onTestFinished(() => useAppStore.setState({
    openNewTaskModal: original.openNewTaskModal,
    openNewRaceModal: original.openNewRaceModal,
  }));
  render(<Sidebar />);
  const caret = screen.getByRole('button', { name: 'More ways to start' });
  expect(caret.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(caret);
  expect(caret.getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(screen.getByRole('menuitem', { name: 'New Task' }));
  expect(openNewTaskModal).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('menu')).toBeNull();
  fireEvent.click(caret);
  fireEvent.click(screen.getByRole('menuitem', { name: 'New Race' }));
  expect(openNewRaceModal).toHaveBeenCalledTimes(1);
});

it('closes the New Session menu on Escape', () => {
  useAppStore.setState({ sidebarCollapsed: false });
  render(<Sidebar />);
  fireEvent.click(screen.getByRole('button', { name: 'More ways to start' }));
  expect(screen.getByRole('menu')).toBeTruthy();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull();
});
