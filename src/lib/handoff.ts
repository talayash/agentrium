import { invoke } from '@tauri-apps/api/core';
import { allAgentSpecs, defaultArgsFor, type AgentKind } from './agents';
import { sessionDisplayName } from './sessionContext';
import { useTerminalStore } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import { useAgentRegistryStore } from '../store/agentRegistryStore';

export interface HandoffChanges {
  changes: { path: string; status: string; staged: boolean }[];
  branch: string | null;
  repo_root: string | null;
  is_git_repo: boolean;
  error: string | null;
}

export function buildHandoffBrief(id: string, changes: HandoffChanges | null): string {
  const terminal = useTerminalStore.getState().terminals.get(id);
  if (!terminal) throw new Error('The source session is no longer open.');
  const { config, sessionContext, sessionSummary } = terminal;
  const files = changes?.changes ?? [];
  return [
    `# Handoff: ${sessionDisplayName(terminal)}`,
    `Working directory: ${config.working_directory}`,
    changes?.branch ? `Branch: ${changes.branch}` : '',
    '', '## Task', sessionContext?.goal || '[Describe the task and acceptance criteria.]',
    '', '## Latest context', sessionContext?.latest || sessionSummary || '[Add progress so far.]',
    '', '## Changed files (current working tree, may include other work)',
    changes?.repo_root ? `Paths relative to: ${changes.repo_root}` : '',
    !changes || changes.error ? '[File changes unavailable. Inspect the working tree.]'
      : !changes.is_git_repo ? 'This directory is not a Git repository.'
      : files.length ? files.slice(0, 100).map(f => `- ${f.path} (${f.status}${f.staged ? ', staged' : ''})`).join('\n')
      : 'No uncommitted changes.',
    files.length > 100 ? `(${files.length - 100} additional files omitted.)` : '',
    '', '## Decisions', '[Add decisions and constraints the next agent should preserve.]',
    '', '## Remaining work', '[Specify the next steps and verification needed.]',
    '', 'Inspect the current files before continuing. Preserve unrelated changes.',
  ].filter(line => line !== '').join('\n\n');
}

export async function loadHandoffBrief(id: string): Promise<string> {
  const changes = await invoke<HandoffChanges>('get_terminal_changes', { id });
  return buildHandoffBrief(id, changes);
}

export async function launchHandoff(sourceId: string, agent: AgentKind, brief: string): Promise<string> {
  const source = useTerminalStore.getState().terminals.get(sourceId);
  if (!source) throw new Error('The source session is no longer open.');
  if (!brief.trim()) throw new Error('Add a handoff brief before continuing.');
  if (!allAgentSpecs().some(spec => spec.kind === agent)) throw new Error('The selected agent is no longer available.');
  const app = useAppStore.getState();
  const id = await useTerminalStore.getState().createTerminal(
    `Handoff: ${sessionDisplayName(source)}`, source.config.working_directory,
    defaultArgsFor(agent, app.defaultAgentArgs), {},
    undefined, undefined, undefined, undefined, false, undefined, agent,
    useAgentRegistryStore.getState().defaultBindingsFor(agent),
  );
  // Stage text in the prompt editor: a new CLI may still be showing a trust or
  // login prompt. Never inject a brief into an unknown terminal input state.
  useAppStore.getState().setPromptDraft(id, brief);
  useAppStore.getState().setSplitMode(false);
  if (useAppStore.getState().gridMode) useAppStore.getState().toggleGridMode();
  useAppStore.getState().openPromptEditor(id, brief);
  return id;
}
