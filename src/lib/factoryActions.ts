import type { AgentKind } from './agents';
import type { TaskInfo } from './tasks';
import { needsStaging, resolveLaunchConfig } from './tasks';
import { nextQueuedFactoryRun, sessionLabel, setFactoryRunTerminal, type RunStep } from './factory';
import { reportInvokeFailure } from './errorReporter';
import { toast } from '../store/toastStore';
import { useTerminalStore } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import { useAgentRegistryStore } from '../store/agentRegistryStore';
import { useFactoryStore } from '../store/factoryStore';

/** Close a terminal if it is still open. */
async function closeLive(terminalId: string | null): Promise<void> {
  if (!terminalId || !useTerminalStore.getState().terminals.has(terminalId)) return;
  await useTerminalStore.getState().closeTerminal(terminalId)
    .catch((err) => reportInvokeFailure('close_terminal', err));
}

/**
 * Open an agent session with its prompt handed over at spawn. When the
 * backend could not deliver it, the prompt is staged in the session's prompt
 * editor, never written into the PTY. Returns the terminal id.
 */
async function openSession(label: string, cwd: string, agent: AgentKind, task: TaskInfo | null, prompt: string): Promise<string> {
  const launch = resolveLaunchConfig(
    agent, null, useAppStore.getState().defaultAgentArgs,
    useAgentRegistryStore.getState().defaultBindingsFor(agent),
  );
  const id = await useTerminalStore.getState().createTerminal(
    label, cwd, launch.args, launch.envVars, undefined, label, undefined, undefined, false, undefined,
    agent, launch.bindings, task, { initialPrompt: prompt },
  );
  if (needsStaging(useTerminalStore.getState().terminals.get(id)?.config.prompt_delivery)) {
    useAppStore.getState().setPromptDraft(id, prompt);
    toast.info('Prompt staged', 'Press Enter in the session to start this station.');
  }
  return id;
}

/**
 * Remember where the user is before a session opens, and return the function
 * that puts them back: a session opened in the background must not steal
 * focus. When the user was looking at `replacing` (the session being
 * replaced), focus follows the new session instead.
 */
function captureFocus(replacing: string | null): () => void {
  const prevActive = useTerminalStore.getState().activeTerminalId;
  const prevFile = useAppStore.getState().activeFilePath;
  const lookingAtOld = prevFile === null && prevActive !== null && prevActive === replacing;
  return () => {
    if (lookingAtOld) return;
    const terminals = useTerminalStore.getState();
    if (prevActive && terminals.terminals.has(prevActive)) terminals.setActiveTerminal(prevActive);
    useAppStore.getState().setActiveFilePath(prevFile);
  };
}

/** Carry out the session side of one engine transition. */
export async function performStep(step: RunStep, factoryName: string): Promise<void> {
  const { run, action } = step;
  switch (action.kind) {
    case 'start_station': {
      const restoreFocus = captureFocus(run.terminalId);
      await closeLive(run.terminalId);
      const label = sessionLabel(factoryName, run, action.stepName);
      let id: string;
      try {
        id = await openSession(label, action.cwd, action.agent, action.task, action.prompt);
      } catch (err) {
        // The run stays as it is: the floor offers Continue.
        toast.error('Could not start the station', String(err));
        reportInvokeFailure('create_terminal', err);
        return;
      }
      useFactoryStore.getState().markSessionOpened(id);
      setFactoryRunTerminal(run.id, id).catch((err) => reportInvokeFailure('set_factory_run_terminal', err));
      useFactoryStore.setState((s) => {
        const stored = s.runs[run.id];
        return stored ? { runs: { ...s.runs, [run.id]: { ...stored, terminalId: id } } } : {};
      });
      // A station starting must not steal focus from wherever the user was.
      restoreFocus();
      return;
    }
    case 'await_gate':
      await closeLive(run.terminalId);
      toast.info('Gate waiting', `${factoryName}: ${run.input} needs your answer.`);
      return;
    case 'finished':
    case 'cancelled':
      await closeLive(run.terminalId);
      return;
    case 'blocked':
      toast.warning('Run blocked', `${factoryName}: ${run.input}`);
      return;
    case 'queued':
    case 'waiting':
      return;
  }
}

/** Start the oldest queued run of a factory once its line is free. */
export async function kickQueue(factoryId: string): Promise<void> {
  try {
    const id = await nextQueuedFactoryRun(factoryId);
    if (id) await useFactoryStore.getState().control(id, 'line_freed');
  } catch {
    // best effort: the next transition retries the queue
  }
}

/** Open the agent session that turns a free-form file into a definition. */
export async function launchImportSession(repoPath: string, prompt: string, agent: AgentKind): Promise<string> {
  return openSession('Factory import', repoPath, agent, null, prompt);
}
