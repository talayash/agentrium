import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ClaudeDefaultsPage from './ClaudeDefaultsPage';
import { useAppStore } from '../../../store/appStore';
import { useAgentRegistryStore } from '../../../store/agentRegistryStore';
import { defaultArgsFor } from '../../../lib/agents';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

beforeEach(() => {
  useAppStore.setState({
    defaultClaudeArgs: ['--existing'],
    defaultAgentArgs: { claude: ['--existing'], codex: [], cursor: [], antigravity: [] },
  });
  useAgentRegistryStore.setState({ customAgents: [] });
});
afterEach(cleanup);

it('saves separate defaults for every built-in agent and preserves the Claude mirror', async () => {
  render(<ClaudeDefaultsPage />);
  for (const [name, kind] of [['Codex', 'codex'], ['Cursor', 'cursor'], ['Antigravity', 'antigravity']] as const) {
    const input = screen.getByRole('textbox', { name: `${name} arguments` });
    fireEvent.change(input, { target: { value: `  --${kind}\n\nvalue  ` } });
    fireEvent.blur(input);
    await waitFor(() => expect(defaultArgsFor(kind, useAppStore.getState().defaultAgentArgs)).toEqual([`--${kind}`, 'value']));
  }
  expect(useAppStore.getState().defaultClaudeArgs).toEqual(['--existing']);
  const claude = screen.getByRole('textbox', { name: 'Claude Code arguments' });
  fireEvent.change(claude, { target: { value: '--updated' } });
  fireEvent.blur(claude);
  await waitFor(() => expect(useAppStore.getState().defaultClaudeArgs).toEqual(['--updated']));
  expect(useAppStore.getState().defaultAgentArgs.codex).toEqual(['--codex', 'value']);
});

it('saves custom agent arguments through the registry so new terminals use them', async () => {
  const agent = {
    id: 'test', name: 'Local Agent', binary: 'local-agent', default_args: ['--old'],
    resume_flag: null, color: '#ffffff', required_env: [], bindings: [],
    install_url: null, install_hint: null, created_at: '2026-01-01', updated_at: '2026-01-01',
  };
  useAgentRegistryStore.setState({ customAgents: [agent] });
  vi.mocked(invoke).mockImplementation(async (_command, payload) => (payload as { agent: typeof agent }).agent);
  render(<ClaudeDefaultsPage />);
  const input = screen.getByRole('textbox', { name: 'Local Agent arguments' });
  fireEvent.change(input, { target: { value: '--new\nvalue' } });
  fireEvent.blur(input);
  await waitFor(() => expect(useAgentRegistryStore.getState().customAgents[0].default_args).toEqual(['--new', 'value']));
  expect(invoke).toHaveBeenCalledWith('save_custom_agent', { agent: { ...agent, default_args: ['--new', 'value'] } });
  expect(defaultArgsFor('custom:test', useAppStore.getState().defaultAgentArgs)).toEqual(['--new', 'value']);
});
