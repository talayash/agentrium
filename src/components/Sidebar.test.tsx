import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
import { useFactoryStore } from '../store/factoryStore';
import type { Definition, Factory, FactoryRun, RunStatus } from '../lib/factory';

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

it('the New menu has a Factory run entry only when the flag is on', () => {
  const original = useAppStore.getState();
  const openNewFactoryRun = vi.fn();
  useAppStore.setState({ sidebarCollapsed: false, factoryEnabled: false, openNewFactoryRun });
  onTestFinished(() => useAppStore.setState({ factoryEnabled: original.factoryEnabled, openNewFactoryRun: original.openNewFactoryRun }));
  const { unmount } = render(<Sidebar />);
  fireEvent.click(screen.getByRole('button', { name: 'More ways to start' }));
  expect(screen.queryByRole('menuitem', { name: 'New Factory run' })).toBeNull();
  unmount();
  useAppStore.setState({ factoryEnabled: true });
  render(<Sidebar />);
  fireEvent.click(screen.getByRole('button', { name: 'More ways to start' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'New Factory run' }));
  expect(openNewFactoryRun).toHaveBeenCalledWith(null);
  expect(screen.queryByRole('menu')).toBeNull();
});

// ---- Factory navigator -------------------------------------------------------
const fdef: Definition = {
  version: 1, name: 'Line', source: 'x', source_sha256: 'h',
  input: { label: 'Ticket', placeholder: 'T-1' }, workspace: 'worktree', agent: 'claude', rules: [],
  steps: [
    { kind: 'station', id: 's1', name: 'Plan', prompt: 'p' },
    { kind: 'gate', id: 'g1', name: 'Approve', question: 'ok?', pass_label: 'Yes', reject_label: 'No', show: [], notes: [], on_reject: 's1' },
  ],
};
const ffactory: Factory = {
  id: 'f1', name: 'Line', repoPath: '/repo', sourcePath: '/repo/line.json', definition: fdef,
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', diskState: 'same',
};
const frun = (id: string, status: RunStatus, step: string): FactoryRun => ({
  id, factoryId: 'f1', input: `T-${id}`, status, currentStep: step, attempts: {}, rejectReason: '', checkOutput: '',
  definition: fdef, workspacePath: '/wt', branch: null, runDir: '/rd', terminalId: null, stationStartedAt: null,
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
});

it('the Factory navigator tab is absent when the flag is off', () => {
  useAppStore.setState({ sidebarCollapsed: false, factoryEnabled: false });
  render(<Sidebar />);
  expect(screen.queryByRole('button', { name: 'Factory' })).toBeNull();
});

it('it is present with a pip showing the needs-you count when the flag is on', () => {
  useAppStore.setState({ sidebarCollapsed: false, factoryEnabled: true });
  useFactoryStore.setState({ factories: { f1: ffactory }, runs: { a: frun('a', 'waiting_gate', 'g1'), b: frun('b', 'running', 's1') } });
  render(<Sidebar />);
  const tab = screen.getByRole('button', { name: 'Factory' });
  expect(tab.getAttribute('data-hue')).toBe('factory');
  expect(tab.querySelector('[aria-label="1 waiting for you"]')?.textContent).toBe('1');
  cleanup();
  useAppStore.setState({ sidebarCollapsed: true });
  render(<Sidebar />);
  expect(screen.getByRole('button', { name: 'Factory' }).querySelector('[aria-label="1 waiting for you"]')).toBeTruthy();
});

it('a persisted factory nav with the flag off shows Sessions', () => {
  useAppStore.setState({ sidebarCollapsed: false, factoryEnabled: false, sidebarNav: 'factory' });
  useFactoryStore.setState({ factories: {}, runs: {} });
  render(<Sidebar />);
  expect(screen.getByRole('radiogroup', { name: 'Session filter' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Sessions' }).getAttribute('aria-pressed')).toBe('true');
  expect(within(screen.getByRole('group', { name: 'Navigator' })).getAllByRole('button')).toHaveLength(3);
});

it('with no factories the Sessions tab is unchanged', () => {
  useAppStore.setState({ sidebarCollapsed: false, factoryEnabled: true, sidebarNav: 'sessions' });
  useFactoryStore.setState({ factories: {}, runs: {} });
  const { container } = render(<Sidebar />);
  expect(container.querySelector('[data-factory-group]')).toBeNull();
  expect(screen.getByRole('radiogroup', { name: 'Session filter' })).toBeTruthy();
});
