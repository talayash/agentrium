import { create } from 'zustand';
import type { SessionContext } from '../lib/sessionContext';
import { invoke } from '@tauri-apps/api/core';
import { Terminal } from '@xterm/xterm';
import type { WorktreeDetectResult } from '../types/git';
import type { AgentKind } from '../lib/agents';
import type { ViewMode } from '../lib/viewMode';
import type { CredentialBinding } from '../lib/credentials';
import type { TaskInfo, TaskStatus } from '../lib/tasks';
import { markTerminalActive, clearTerminalActivity, markTerminalSubmission } from '../lib/terminalActivity';
import { useSessionAttentionStore } from './sessionAttentionStore';
import { useInsightStore } from './insightStore';
import { reportInvokeFailure } from '../lib/errorReporter';
import { toast } from './toastStore';
import { chunkUtf8Bytes } from '../lib/chunkUtf8';
import type { SessionState } from '../lib/terminalState';
import { mergeMetrics, emptyMetrics, type SessionMetrics, type TerminalMetricsPayload } from '../lib/sessionMetrics';
import { usePreviewStore, type PreviewState } from './previewStore';
import { detectFramework, type FrameworkHint } from '../lib/preview/framework';

// Stay safely under the backend's 64 KB per-write cap so very large pastes
// (multi-hundred KB) don't hit "Write payload too large".
const TERMINAL_WRITE_CHUNK_BYTES = 60 * 1024;
const terminalInputWrites = new Map<string, Promise<void>>();

// PTY output can arrive before the xterm instance is attached: the backend
// starts streaming as soon as it spawns Claude Code (reader thread + mpsc
// drainer), while the frontend still needs `await invoke` to resolve, `set()`
// to add the terminal to the store, React to mount TerminalView, xterm to
// initialize, and setXterm to register the ref. Anything in that window used
// to be silently dropped by handleTerminalOutput, which broke ANSI escape
// parsing and left new tabs showing a blank screen with a stray `[` (issue
// #48). We buffer chunks here keyed by terminal id and drain them when
// setXterm attaches the real xterm. Bounded so a runaway id (e.g. events for
// a terminal that lives in another window) can't grow the buffer forever.
interface OutputChunk { data: Uint8Array; sequence?: number }
interface PendingOutput { chunks: OutputChunk[]; bytes: number }
const pendingOutputBuffers = new Map<string, PendingOutput>();
const replayRequests = new Map<string, object>();
const lastDeliveredSequences = new WeakMap<Terminal, number>();
const parsingOutput = new WeakMap<Terminal, { chunks: OutputChunk[]; active: boolean }>();
const MAX_PENDING_OUTPUT_BYTES_PER_TERMINAL = 512 * 1024;
const outputAcknowledgements = new Map<string, { sequence: number; timer?: ReturnType<typeof setTimeout>; sending: boolean }>();

function acknowledgeOutput(id: string, sequence: number): void {
  let entry = outputAcknowledgements.get(id);
  if (!entry) {
    entry = { sequence, sending: false };
    outputAcknowledgements.set(id, entry);
  }
  entry.sequence = Math.max(entry.sequence, sequence);
  if (entry.sending || entry.timer) return;
  const current = entry;
  const send = async () => {
    current.timer = undefined;
    if (outputAcknowledgements.get(id) !== current) return;
    current.sending = true;
    const sent = current.sequence;
    try {
      await invoke('acknowledge_terminal_output', { id, sequence: sent });
      current.sending = false;
      if (outputAcknowledgements.get(id) !== current) return;
      if (current.sequence === sent) outputAcknowledgements.delete(id);
      else current.timer = setTimeout(() => { void send(); }, 0);
    } catch {
      current.sending = false;
      // Background delivery: retry credits after transient IPC failure so a
      // busy renderer never leaves the PTY permanently paused.
      if (outputAcknowledgements.get(id) === current && useTerminalStore.getState().terminals.has(id)) {
        current.timer = setTimeout(() => { void send(); }, 250);
      } else outputAcknowledgements.delete(id);
    }
  };
  current.timer = setTimeout(() => { void send(); }, 0);
}

function bufferPendingOutput(id: string, data: Uint8Array, sequence?: number): void {
  let pending = pendingOutputBuffers.get(id);
  // Other windows also receive the global stream. Retain a recent bounded
  // tail for adoption, not the first 512 KB forever. All unacknowledged output
  // fits inside this tail (backend window: 256 KB), so transfer cannot strand
  // credits held by the departing renderer.
  if (pending && !useTerminalStore.getState().terminals.has(id)) {
    while (pending.bytes + data.byteLength > MAX_PENDING_OUTPUT_BYTES_PER_TERMINAL && pending.chunks.length) {
      pending.bytes -= pending.chunks.shift()!.data.byteLength;
    }
  }
  if ((pending?.bytes ?? 0) + data.byteLength > MAX_PENDING_OUTPUT_BYTES_PER_TERMINAL) return;
  if (!pending) {
    pending = { chunks: [], bytes: 0 };
    pendingOutputBuffers.set(id, pending);
  }
  pending.chunks.push({ data, sequence });
  pending.bytes += data.byteLength;
}

function writeOutput(id: string, xterm: Terminal, chunk: OutputChunk): void {
  if (chunk.sequence === undefined) { xterm.write(chunk.data); return; }
  // A transfer snapshot can overlap live global events still in transit.
  if (chunk.sequence <= (lastDeliveredSequences.get(xterm) ?? 0)) return;
  lastDeliveredSequences.set(xterm, chunk.sequence);
  let parsing = parsingOutput.get(xterm);
  if (!parsing) {
    parsing = { chunks: [], active: true };
    parsingOutput.set(xterm, parsing);
  }
  const owner = parsing;
  owner.chunks.push(chunk);
  xterm.write(chunk.data, () => {
    if (!owner.active) return;
    const index = owner.chunks.indexOf(chunk);
    if (index !== -1) owner.chunks.splice(index, 1);
    acknowledgeOutput(id, chunk.sequence!);
  });
}

function detachOutput(id: string, xterm: Terminal): void {
  const parsing = parsingOutput.get(xterm);
  if (!parsing) return;
  parsing.active = false;
  parsingOutput.delete(xterm);
  // xterm's synchronous parser commits whole write chunks. Preserve writes
  // still queued when a view is disposed, after its serialized parsed screen.
  const pending = pendingOutputBuffers.get(id);
  const chunks = [...parsing.chunks, ...(pending?.chunks ?? [])];
  if (chunks.length) pendingOutputBuffers.set(id, { chunks, bytes: chunks.reduce((n, c) => n + c.data.byteLength, 0) });
}

function drainPendingOutput(id: string, xterm: Terminal): void {
  const pending = pendingOutputBuffers.get(id);
  if (!pending) return;
  pendingOutputBuffers.delete(id);
  for (const chunk of pending.chunks) writeOutput(id, xterm, chunk);
}

function replayTransferredOutput(id: string, token: object): void {
  const current = () => replayRequests.get(id) === token && useTerminalStore.getState().terminals.has(id);
  invoke<{ sequence: number; data: number[] }[]>('pending_terminal_output', { id }).then((batches) => {
    if (!current()) return;
    const merged = new Map<number, OutputChunk>();
    for (const chunk of pendingOutputBuffers.get(id)?.chunks ?? []) {
      if (chunk.sequence !== undefined) merged.set(chunk.sequence, chunk);
    }
    for (const batch of batches ?? []) merged.set(batch.sequence, { sequence: batch.sequence, data: new Uint8Array(batch.data) });
    const chunks = [...merged.values()].sort((a, b) => a.sequence! - b.sequence!);
    pendingOutputBuffers.set(id, { chunks, bytes: chunks.reduce((n, c) => n + c.data.byteLength, 0) });
    replayRequests.delete(id);
    const xterm = useTerminalStore.getState().terminals.get(id)?.xterm;
    if (xterm) drainPendingOutput(id, xterm);
  }).catch(() => {
    // Background transfer recovery: retry rather than discard outstanding
    // output or strand backend credits after a transient IPC failure.
    if (current()) setTimeout(() => { if (current()) replayTransferredOutput(id, token); }, 250);
    else if (replayRequests.get(id) === token) replayRequests.delete(id);
  });
}

/** Test-only: clear the pre-attach buffer. Vitest keeps module state across
 *  test cases, so beforeEach hooks in terminalStore.test.ts call this to stop
 *  leftover chunks from an earlier case leaking into the next replay. Not for
 *  production use. */
export function __resetPendingOutputBuffersForTest(): void {
  pendingOutputBuffers.clear();
  replayRequests.clear();
  for (const entry of outputAcknowledgements.values()) clearTimeout(entry.timer);
  outputAcknowledgements.clear();
}

/**
 * Best-effort framework detection for the Preview panel. Reads the terminal's
 * cwd/package.json via the existing `list_package_scripts` IPC (no new Rust
 * command or fs plugin required), reconstructs a minimal package.json shape,
 * and seeds the preview store with the detected framework hint.
 *
 * The IPC only exposes `scripts.*` - not `dependencies` - so detection here is
 * limited to the `scripts.dev` path of `detectFramework`, which matches the
 * common case (`next dev`, `vite`, `astro dev`, `nuxt dev`, `svelte`, `ng serve`,
 * `react-scripts start`, `expo start`, `remix dev`). That is enough for the
 * default port and hint to feed downstream UX. Failures are swallowed silently.
 */
async function seedFrameworkHint(terminalId: string, cwd: string): Promise<void> {
  if (!cwd) return;
  try {
    const scripts = await invoke<{ name: string; command: string }[]>(
      'list_package_scripts',
      { cwd },
    );
    if (!scripts || scripts.length === 0) return;
    const scriptsMap: Record<string, string> = {};
    for (const s of scripts) scriptsMap[s.name] = s.command;
    const { hint } = detectFramework({ scripts: scriptsMap });
    if (hint !== 'unknown') {
      const seed: Partial<PreviewState> = { frameworkHint: hint as FrameworkHint };
      usePreviewStore.getState().seedTerminal(terminalId, seed);
    }
  } catch {
    // no package.json, invalid JSON, path not trusted - silent.
  }
}

export interface TerminalConfig {
  id: string;
  label: string;
  nickname: string | null;
  profile_id: string | null;
  working_directory: string;
  claude_args: string[];
  env_vars: Record<string, string>;
  created_at: string;
  status: 'Running' | 'Idle' | 'Error' | 'Stopped';
  color_tag: string | null;
  agent: AgentKind;
  /** UUID of the Claude Code conversation this terminal is bound to. Populated
   *  by the backend a few seconds after spawn (snapshot/diff of
   *  ~/.claude/projects/<encoded-cwd>/*.jsonl) and used by session restore to
   *  re-attach via `claude --resume <id>`. */
  claude_session_id?: string | null;
  /** Per-terminal env-var → credential-id bindings applied when the PTY is
   *  spawned. Optional so older persisted rows (Rust `#[serde(default)]`)
   *  deserialize to `[]`. */
  credential_bindings?: CredentialBinding[];
  /** Set for terminals started by the New Task flow. Persisted by the backend
   *  with session restore (Rust `#[serde(default)]`). */
  task?: TaskInfo | null;
  /** How a spawn-time initial prompt reached the agent (Race mode). Only on
   *  the config `create_terminal` returns; never restored. */
  prompt_delivery?: PromptDelivery | null;
  /** Per-session view mode (Rust `#[serde(default)]`, default `cli`). Persisted
   *  with session restore; never part of any sync payload. */
  view_mode?: ViewMode;
}

/** Mirrors Rust `terminal::PromptDelivery`. */
export type PromptDelivery =
  | { mode: 'argv' }
  | { mode: 'file'; path: string }
  | { mode: 'staged' };

export interface CreateTerminalOptions {
  /** Race mode: first prompt delivered at spawn through argv (or a prompt
   *  file) when the agent supports it. */
  initialPrompt?: string;
  /** Branch `resumeSessionId` into a new conversation (Claude and Codex). */
  fork?: boolean;
  /** View mode for this session. Falls back to the global default
   *  (`defaultViewMode`) when omitted; session restore always passes the
   *  saved value so the default is ignored. */
  viewMode?: ViewMode;
}

export interface LoopInfo {
  interval: string;
  prompt: string;
}

export interface TerminalInstance {
  config: TerminalConfig;
  xterm: Terminal | null;
  restoredOutput?: string;
  // Serialized xterm buffer stashed when the view unmounts (e.g. switching
  // tab <-> grid/split), replayed on remount so scrollback survives the
  // teardown that xterm's single-DOM-node model forces. Distinct from
  // restoredOutput, which is persisted session history shown with banners.
  carryOverBuffer?: string;
  model?: string;
  effort?: string;
  isWorktree: boolean;
  loopInfo?: LoopInfo | null;
  sessionSummary?: string | null;
  sessionContext?: SessionContext | null;
  // Script-child metadata: when set, this terminal is an npm-script runner
  // spawned below a parent terminal. Excluded from the tab list and sidebar.
  scriptName?: string;
  scriptParentId?: string;
  // Plain interactive shell at a directory (no claude). Renders in the bottom
  // BottomTerminalPane, not the main tab bar / sidebar.
  isShellTerminal?: boolean;
}

interface TerminalState {
  terminals: Map<string, TerminalInstance>;
  activeTerminalId: string | null;
  unreadTerminalIds: Set<string>;
  // Inferred Claude session state per terminal (busy/waiting/idle/stopped).
  // Written only on transitions by the detection poller - never on the
  // streaming hot path - so subscribers re-render only when state changes.
  terminalStates: Map<string, SessionState>;
  // Timestamp when a terminal most recently transitioned busy → idle. Drives
  // the "just finished" green flash on the tab underline. Cleared ~850 ms
  // after the transition so React unmounts the class cleanly.
  justFinishedAt: Map<string, number>;
  // Live per-terminal cost/token metrics from the OTel receiver.
  terminalMetrics: Map<string, SessionMetrics>;
  // Terminals already warned about exceeding the budget cap (fire-once).
  budgetWarnedIds: Set<string>;
  markBudgetWarned: (id: string) => void;
  gitInfoCache: Map<string, WorktreeDetectResult>;
  // Task terminals: commits ahead/behind the task's base branch. Refreshed
  // alongside gitInfoCache by fetchGitInfo.
  taskDivergence: Map<string, { ahead: number; behind: number }>;
  // Parent terminal ID → script child terminal ID (one child per parent).
  scriptChildren: Map<string, string>;
  // Bottom pane (interactive shells the user opens from the Repositories list).
  bottomTerminalIds: string[];
  activeBottomTerminalId: string | null;

  createTerminal: (
    label: string,
    workingDirectory: string,
    claudeArgs: string[],
    envVars: Record<string, string>,
    colorTag?: string,
    nickname?: string,
    restoredOutput?: string,
    resumeSessionId?: string,
    continueRecent?: boolean,
    previewInit?: Partial<PreviewState>,
    agent?: AgentKind,
    credentialBindings?: CredentialBinding[],
    task?: TaskInfo | null,
    options?: CreateTerminalOptions,
  ) => Promise<string>;
  createShellTerminalTab: (
    label: string,
    workingDirectory: string,
    colorTag?: string,
    nickname?: string,
  ) => Promise<string>;
  closeTerminal: (id: string) => Promise<void>;
  setActiveTerminal: (id: string) => void;
  updateLabel: (id: string, label: string) => Promise<void>;
  // Backend bound (or rotated) the agent conversation id for a live terminal.
  setSessionId: (id: string, sessionId: string) => void;
  updateNickname: (id: string, nickname: string) => Promise<void>;
  setViewMode: (id: string, mode: ViewMode) => Promise<void>;
  writeToTerminal: (id: string, data: string) => Promise<void>;
  // Writes each element as its own PTY write, awaiting each and pausing gapMs
  // between them. Used only for AskUserQuestion answer keys (src/lib/questionKeys.ts).
  sendKeySequence: (id: string, keys: string[], gapMs?: number) => Promise<void>;
  resizeTerminal: (id: string, cols: number, rows: number) => Promise<void>;
  setXterm: (id: string, xterm: Terminal | null) => void;
  stashTerminalBuffer: (id: string, data: string) => void;
  handleTerminalOutput: (id: string, data: Uint8Array, sequence?: number) => void;
  updateTerminalStatus: (id: string, status: TerminalConfig['status']) => void;
  setLoopMode: (id: string, info: LoopInfo | null) => void;
  setSessionSummary: (id: string, summary: string | null) => void;
  setSessionContext: (id: string, context: SessionContext) => void;
  getTerminalList: () => TerminalConfig[];
  clearUnread: (id: string) => void;
  hasUnread: (id: string) => boolean;
  setTerminalState: (id: string, state: SessionState) => void;
  applyTerminalMetrics: (payload: TerminalMetricsPayload) => void;
  fetchGitInfo: (terminalId: string) => Promise<void>;
  reorderTerminals: (orderedIds: string[]) => void;

  // Multi-window tear-off support. The PTY lives in the shared backend, so
  // moving a tab between windows is purely a frontend store handoff:
  //   - adoptTerminal: register a terminal whose PTY already exists (NO spawn).
  //     Used when a tab is torn off / transferred into this window. An optional
  //     restoredOutput seeds prior scrollback (from get_session_log), mirroring
  //     session restore.
  //   - detachTerminals: remove terminals from THIS window's store + dispose
  //     their xterms WITHOUT calling close_terminal - the PTY keeps running so
  //     another window can adopt it.
  adoptTerminal: (config: TerminalConfig, restoredOutput?: string) => void;
  detachTerminals: (ids: string[]) => void;

  // Run an npm script in a child terminal tied to the given parent. Returns
  // the new child's id. If the parent already has a script running, that
  // child is closed first so the new one replaces it. `cwdOverride` lets the
  // caller run the script in a directory other than the parent's cwd - used
  // by the package.json CodeLens, where the script's cwd is the file's folder.
  runScript: (parentId: string, scriptName: string, cwdOverride?: string) => Promise<string>;
  closeScript: (parentId: string) => Promise<void>;

  // Bottom shell-terminal pane
  openShellTerminal: (label: string, cwd: string) => Promise<string>;
  closeShellTerminal: (id: string) => Promise<void>;
  setActiveBottomTerminal: (id: string | null) => void;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  terminals: new Map(),
  activeTerminalId: null,
  unreadTerminalIds: new Set(),
  terminalStates: new Map(),
  justFinishedAt: new Map(),
  terminalMetrics: new Map(),
  budgetWarnedIds: new Set(),
  gitInfoCache: new Map(),
  taskDivergence: new Map(),
  scriptChildren: new Map(),
  bottomTerminalIds: [],
  activeBottomTerminalId: null,

  createTerminal: async (label, workingDirectory, claudeArgs, envVars, colorTag, nickname, restoredOutput, resumeSessionId, continueRecent, previewInit, agent: AgentKind = 'claude', credentialBindings, task, options) => {
    try {
      const { useAppStore } = await import('./appStore');
      const costTracking = useAppStore.getState().costTrackingEnabled;
      const viewMode = options?.viewMode ?? useAppStore.getState().defaultViewMode;
      const config = await invoke<TerminalConfig>('create_terminal', {
        request: {
          label,
          working_directory: workingDirectory,
          claude_args: claudeArgs,
          env_vars: envVars,
          color_tag: colorTag || null,
          nickname: nickname || null,
          resume_session_id: resumeSessionId || null,
          continue_recent: !!continueRecent,
          cost_tracking: costTracking,
          agent,
          credential_bindings: credentialBindings ?? [],
          task: task ?? null,
          initial_prompt: options?.initialPrompt ?? null,
          fork: !!options?.fork,
          view_mode: viewMode,
        },
      });
      // Parse model, effort, worktree from claude_args
      let model: string | undefined;
      let effort: string | undefined;
      const isWorktree = claudeArgs.includes('--worktree');
      for (let i = 0; i < claudeArgs.length; i++) {
        if (claudeArgs[i] === '--model' && i + 1 < claudeArgs.length) {
          model = claudeArgs[i + 1];
        }
        if (claudeArgs[i] === '--effort' && i + 1 < claudeArgs.length) {
          effort = claudeArgs[i + 1];
        }
      }

      set((state) => {
        const newTerminals = new Map(state.terminals);
        newTerminals.set(config.id, { config, xterm: null, restoredOutput, model, effort, isWorktree });
        return {
          terminals: newTerminals,
          activeTerminalId: config.id,
        };
      });

      // Fetch git info in the background
      get().fetchGitInfo(config.id);

      // Seed the preview store with any per-profile hints the caller passed in.
      // Callers that don't know about the preview feature (grid, restore, tests)
      // omit previewInit entirely, in which case we still seed with defaults so
      // downstream reads never hit an undefined per-terminal state.
      if (previewInit) {
        usePreviewStore.getState().seedTerminal(config.id, previewInit);
        // Auto-open the panel when a "Has GUI preview" profile launches a tab.
        if (previewInit.isOpen && !usePreviewStore.getState().globalOpen) {
          usePreviewStore.getState().toggleGlobal();
        }
      }

      // Fire-and-forget: probe package.json for a framework hint. Runs even if
      // the caller didn't pass previewInit - that way an ad-hoc terminal in a
      // Vite/Next repo gets its hint auto-detected.
      void seedFrameworkHint(config.id, workingDirectory);

      return config.id;
    } catch (error) {
      reportInvokeFailure('create_terminal', error);
      throw error;
    }
  },

  createShellTerminalTab: async (label, workingDirectory, colorTag, nickname) => {
    try {
      const config = await invoke<TerminalConfig>('create_shell_terminal', {
        label,
        cwd: workingDirectory,
      });
      // Apply nickname/color_tag the user picked in the modal - the backend
      // command takes only label+cwd, so we patch the persisted record here.
      // (Falls back silently if either is empty to avoid a needless IPC.)
      if (nickname) {
        try { await invoke('update_terminal_nickname', { id: config.id, nickname }); } catch { /* non-fatal */ }
      }
      const patchedConfig: TerminalConfig = {
        ...config,
        color_tag: colorTag ?? config.color_tag ?? null,
        nickname: nickname ?? config.nickname,
      };

      set((state) => {
        const newTerminals = new Map(state.terminals);
        // Intentionally NOT setting isShellTerminal - that flag is for bottom-
        // pane shells. Main-tab shells appear in the sidebar and tab bar like
        // any other terminal; their plain-shell-ness is recorded durably in
        // the backend via claude_args=["__shell__"].
        newTerminals.set(patchedConfig.id, {
          config: patchedConfig,
          xterm: null,
          isWorktree: false,
        });
        return {
          terminals: newTerminals,
          activeTerminalId: patchedConfig.id,
        };
      });

      get().fetchGitInfo(patchedConfig.id);

      return patchedConfig.id;
    } catch (error) {
      reportInvokeFailure('create_shell_terminal', error);
      throw error;
    }
  },

  closeTerminal: async (id) => {
    // If this terminal owns a script child, kill it first so it doesn't linger
    // as an orphan (visible only via devtools).
    const childId = get().scriptChildren.get(id);
    if (childId) {
      try { await invoke('close_terminal', { id: childId }); } catch { /* already gone */ }
    }

    // Best-effort paste cleanup BEFORE close_terminal - the backend resolves
    // terminal_id → cwd via the still-alive TerminalManager. Dynamic-import
    // to avoid an appStore↔terminalStore import cycle.
    try {
      const { useAppStore } = await import('./appStore');
      const { usePasteStore } = await import('./pasteStore');
      if (useAppStore.getState().pasteRetention === 'close') {
        await invoke('purge_pastes', { terminalId: id }).catch(() => {});
      }
      usePasteStore.getState().clearForTerminal(id);
      // Ghost-pin GC: if this terminal was pinned, drop the id from the
      // persisted pinnedTabIds so it doesn't leak forever. Without this,
      // right-click → Pin → Close leaves the id in localStorage across
      // sessions and pinnedTabIds grows unbounded. The startup GC in
      // App.tsx catches the restart case; this covers the live case.
      useAppStore.getState().unpinTab(id);
      if (childId) useAppStore.getState().unpinTab(childId);
    } catch {
      // ignore - cleanup is best-effort
    }

    await invoke('close_terminal', { id });

    // Drop any pre-attach buffered output - the terminal is gone, so replay
    // makes no sense and the entry would linger until process exit.
    pendingOutputBuffers.delete(id);
    useInsightStore.getState().clear(id);
    if (childId) pendingOutputBuffers.delete(childId);

    set((state) => {
      const newTerminals = new Map(state.terminals);
      const instance = newTerminals.get(id);
      if (instance?.xterm) {
        instance.xterm.dispose();
      }
      newTerminals.delete(id);

      // Also drop any script child from the terminal map.
      if (childId) {
        const childInst = newTerminals.get(childId);
        if (childInst?.xterm) childInst.xterm.dispose();
        newTerminals.delete(childId);
      }

      const newUnread = new Set(state.unreadTerminalIds);
      newUnread.delete(id);

      // Clear activity tracking so a stale lastOutputAt can't pulse a
      // re-created terminal that happens to reuse the same id.
      clearTerminalActivity(id);
      if (childId) clearTerminalActivity(childId);

      const newGitCache = new Map(state.gitInfoCache);
      newGitCache.delete(id);
      const newTaskDivergence = new Map(state.taskDivergence);
      newTaskDivergence.delete(id);

      const newStates = new Map(state.terminalStates);
      newStates.delete(id);
      if (childId) newStates.delete(childId);

      const newChildren = new Map(state.scriptChildren);
      newChildren.delete(id);

      const newMetrics = new Map(state.terminalMetrics);
      newMetrics.delete(id);
      if (childId) newMetrics.delete(childId);

      const newBudgetWarned = new Set(state.budgetWarnedIds);
      newBudgetWarned.delete(id);
      if (childId) newBudgetWarned.delete(childId);

      // Drop preview state for this terminal (and any script child) - mirrors
      // the unread/metrics/git-cache cleanup above so nothing points at a gone id.
      usePreviewStore.getState().removeTerminal(id);
      if (childId) usePreviewStore.getState().removeTerminal(childId);

      // Only pick a fallback from terminals that actually appear in the main
      // tab bar - script children and bottom-pane shells must never become
      // the "active tab".
      const remainingIds = Array.from(newTerminals.values())
        .filter((t) => !t.scriptParentId && !t.isShellTerminal)
        .map((t) => t.config.id);
      return {
        terminals: newTerminals,
        unreadTerminalIds: newUnread,
        gitInfoCache: newGitCache,
        taskDivergence: newTaskDivergence,
        terminalStates: newStates,
        scriptChildren: newChildren,
        terminalMetrics: newMetrics,
        budgetWarnedIds: newBudgetWarned,
        activeTerminalId: state.activeTerminalId === id
          ? (remainingIds[0] || null)
          : state.activeTerminalId,
      };
    });
  },

  setActiveTerminal: (id) => set((state) => {
    const newUnread = new Set(state.unreadTerminalIds);
    newUnread.delete(id);
    return { activeTerminalId: id, unreadTerminalIds: newUnread };
  }),

  setSessionId: (id, sessionId) => set((state) => {
    const instance = state.terminals.get(id);
    if (!instance || instance.config.claude_session_id === sessionId) return state;
    const newTerminals = new Map(state.terminals);
    newTerminals.set(id, { ...instance, config: { ...instance.config, claude_session_id: sessionId } });
    return { terminals: newTerminals };
  }),

  updateLabel: async (id, label) => {
    await invoke('update_terminal_label', { id, label });

    set((state) => {
      const newTerminals = new Map(state.terminals);
      const instance = newTerminals.get(id);
      if (instance) {
        // Immutable update: replace the instance/config objects rather than
        // mutating them in place, so React.memo consumers keyed on config
        // identity re-render and prior-state snapshots aren't corrupted.
        newTerminals.set(id, { ...instance, config: { ...instance.config, label } });
      }
      return { terminals: newTerminals };
    });
  },

  setViewMode: async (id, mode) => {
    try {
      await invoke('set_terminal_view_mode', { id, mode });
    } catch (err) {
      toast.error('Could not change the view mode', err instanceof Error ? err.message : String(err));
      reportInvokeFailure('set_terminal_view_mode', err);
      return;
    }
    set((state) => {
      const instance = state.terminals.get(id);
      if (!instance) return {};
      const newTerminals = new Map(state.terminals);
      newTerminals.set(id, { ...instance, config: { ...instance.config, view_mode: mode } });
      return { terminals: newTerminals };
    });
  },

  updateNickname: async (id, nickname) => {
    await invoke('update_terminal_nickname', { id, nickname });

    set((state) => {
      const newTerminals = new Map(state.terminals);
      const instance = newTerminals.get(id);
      if (instance) {
        newTerminals.set(id, { ...instance, config: { ...instance.config, nickname } });
      }
      return { terminals: newTerminals };
    });
  },

  writeToTerminal: async (id, data) => {
    if ((data.endsWith('\r') || data === '\n') && !data.includes('\x1b[200~')) {
      markTerminalSubmission(id);
      useSessionAttentionStore.getState().clear(id);
    }
    const bytes = new TextEncoder().encode(data);
    // Keep whole pastes and subsequent keystrokes ordered per session. Other
    // terminals have independent queues and remain interactive.
    const previous = terminalInputWrites.get(id) ?? Promise.resolve();
    const write = previous.catch(() => { /* the original caller reports its failure */ }).then(async () => {
      if (bytes.length <= TERMINAL_WRITE_CHUNK_BYTES) {
        await invoke('write_to_terminal', { id, data: Array.from(bytes) });
        return;
      }
      for (const chunk of chunkUtf8Bytes(bytes, TERMINAL_WRITE_CHUNK_BYTES)) {
        await invoke('write_to_terminal', { id, data: Array.from(chunk) });
      }
    });
    terminalInputWrites.set(id, write);
    try { await write; }
    finally { if (terminalInputWrites.get(id) === write) terminalInputWrites.delete(id); }
  },

  sendKeySequence: async (id, keys, gapMs = 40) => {
    const write = get().writeToTerminal;
    for (let i = 0; i < keys.length; i++) {
      if (i > 0) await new Promise<void>((resolve) => setTimeout(resolve, gapMs));
      await write(id, keys[i]!);
    }
  },

  resizeTerminal: async (id, cols, rows) => {
    await invoke('resize_terminal', { id, cols, rows });
  },

  setXterm: (id, xterm) => {
    // Clearing the ref (xterm === null) on unmount/dispose. Without this the
    // store keeps pointing at a disposed Terminal, and handleTerminalOutput
    // would keep calling write() on it (a disposed instance is still truthy)
    // whenever the PTY streams while the view is unmounted (e.g. grid/split).
    if (!xterm) {
      const previous = get().terminals.get(id)?.xterm;
      if (previous) detachOutput(id, previous);
      set((state) => {
        const inst = state.terminals.get(id);
        if (!inst) return state;
        // Copy the instance rather than mutating in place: mutating the entry
        // in the Map before set() commits leaves the OLD state's object with
        // the new field, breaking Zustand's shallow-equality check for any
        // selector still holding a reference to that snapshot.
        const newTerminals = new Map(state.terminals);
        newTerminals.set(id, { ...inst, xterm: null });
        return { terminals: newTerminals };
      });
      return;
    }

    const { terminals } = get();
    const instance = terminals.get(id);

    // Write restored session output before any live output
    if (instance?.restoredOutput) {
      const lines = instance.restoredOutput.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      xterm.write('\x1b[90m─── Previous session output ───\x1b[0m\r\n\r\n');
      xterm.write(lines.replace(/\n/g, '\r\n'));
      xterm.write('\r\n\r\n\x1b[90m─── Session restored ───\x1b[0m\r\n\r\n');
    } else if (instance?.carryOverBuffer) {
      // Replay a buffer stashed on a view switch, verbatim and banner-free -
      // this is the same live session, just re-rendered into a new xterm.
      xterm.write(instance.carryOverBuffer);
    }

    // Replay any PTY chunks that arrived before this xterm was attached (the
    // spawn→attach race that used to leave issue-#48 tabs blank). Ordered
    // after restoredOutput/carryOverBuffer so historical scrollback stays
    // above the live stream - same ordering rule the reader thread enforces.
    if (!replayRequests.has(id)) drainPendingOutput(id, xterm);

    set((state) => {
      const inst = state.terminals.get(id);
      if (!inst) return state;
      // Copy-on-set (see setXterm(null) above for the rationale).
      // Destructure the transient fields out so the new entry drops them.
      const { restoredOutput: _r, carryOverBuffer: _c, ...rest } = inst;
      const newTerminals = new Map(state.terminals);
      newTerminals.set(id, { ...rest, xterm });
      return { terminals: newTerminals };
    });
  },

  stashTerminalBuffer: (id, data) => {
    set((state) => {
      const inst = state.terminals.get(id);
      // No-op if the terminal is gone (permanently closed) - nothing to carry.
      if (!inst) return state;
      // Copy-on-set: creating a new instance object so previous snapshots stay
      // valid for selectors that captured them.
      const newTerminals = new Map(state.terminals);
      newTerminals.set(id, { ...inst, carryOverBuffer: data });
      return { terminals: newTerminals };
    });
  },

  handleTerminalOutput: (id, data, sequence) => {
    const state = get();
    const instance = state.terminals.get(id);
    if (instance?.xterm && !replayRequests.has(id)) {
      // Guard against a dispose/output race: if the view unmounted between the
      // store read and this write, xterm.write() on a disposed instance throws.
      // Swallow it rather than surface an UnhandledRejection in the event loop.
      try {
        writeOutput(id, instance.xterm, { data, sequence });
      } catch {
        /* terminal disposed - drop this chunk */
      }
    } else {
      // No xterm attached yet (spawn→attach race on a brand-new tab, or the
      // instance hasn't been added to state yet because `set()` from
      // createTerminal is still queued behind this event). Buffer the chunk so
      // setXterm can replay it once the view mounts. Fixes the "new terminal
      // opens blank" bug (issue #48): a single dropped byte at the start of
      // Claude Code's ANSI-heavy welcome banner wedged xterm's escape parser
      // and left the whole tab looking empty.
      bufferPendingOutput(id, data, sequence);
    }
    // Active-work indicator: record the timestamp in a plain Map (no Zustand
    // set() - that would defeat the streaming-rate optimization below).
    markTerminalActive(id);
    // Short-circuit - if the terminal is already marked unread, skip the
    // Set clone + set() call. At streaming rates this used to fire thousands
    // of times per second and re-render every subscriber.
    if (id !== state.activeTerminalId && !state.unreadTerminalIds.has(id)) {
      set((s) => {
        const newUnread = new Set(s.unreadTerminalIds);
        newUnread.add(id);
        return { unreadTerminalIds: newUnread };
      });
    }
  },

  updateTerminalStatus: (id, status) => {
    if (!get().terminals.has(id)) pendingOutputBuffers.delete(id);
    set((state) => {
      const newTerminals = new Map(state.terminals);
      const instance = newTerminals.get(id);
      if (instance) {
        newTerminals.set(id, { ...instance, config: { ...instance.config, status } });
      }
      return { terminals: newTerminals };
    });
  },

  setLoopMode: (id, info) => {
    const previous = get().terminals.get(id)?.loopInfo;
    if (previous?.interval === info?.interval && previous?.prompt === info?.prompt) return;
    set((state) => {
      const newTerminals = new Map(state.terminals);
      const instance = newTerminals.get(id);
      if (instance) {
        newTerminals.set(id, { ...instance, loopInfo: info });
      }
      return { terminals: newTerminals };
    });
  },

  setSessionContext: (id, context) => set((state) => {
    const instance = state.terminals.get(id);
    if (!instance) return {};
    const terminals = new Map(state.terminals);
    terminals.set(id, { ...instance, sessionContext: context });
    return { terminals };
  }),

  setSessionSummary: (id, summary) => {
    set((state) => {
      const newTerminals = new Map(state.terminals);
      const instance = newTerminals.get(id);
      if (instance) {
        newTerminals.set(id, { ...instance, sessionSummary: summary });
      }
      return { terminals: newTerminals };
    });
  },

  getTerminalList: () => {
    const { terminals } = get();
    return Array.from(terminals.values()).map((t) => t.config);
  },

  clearUnread: (id) => set((state) => {
    const newUnread = new Set(state.unreadTerminalIds);
    newUnread.delete(id);
    return { unreadTerminalIds: newUnread };
  }),

  hasUnread: (id) => {
    return get().unreadTerminalIds.has(id);
  },

  setTerminalState: (id, state) => {
    // Short-circuit before set() so unchanged states cause zero re-renders.
    const prev = get().terminalStates.get(id);
    if (prev === state) return;
    set((s) => {
      const next = new Map(s.terminalStates);
      next.set(id, state);
      return { terminalStates: next };
    });
    // Busy → idle transition: mark the tab so its underline flashes green.
    if (prev === 'busy' && state === 'idle') {
      const stamp = Date.now();
      set((s) => {
        const jf = new Map(s.justFinishedAt);
        jf.set(id, stamp);
        return { justFinishedAt: jf };
      });
      setTimeout(() => {
        set((s) => {
          if (s.justFinishedAt.get(id) !== stamp) return {};
          const jf = new Map(s.justFinishedAt);
          jf.delete(id);
          return { justFinishedAt: jf };
        });
      }, 850);
    }
  },

  applyTerminalMetrics: (payload) => {
    const id = payload.terminal_id;
    set((s) => {
      const prev = s.terminalMetrics.get(id) ?? emptyMetrics();
      const next = mergeMetrics(prev, payload);
      const map = new Map(s.terminalMetrics);
      map.set(id, next);
      return { terminalMetrics: map };
    });
  },

  markBudgetWarned: (id) => set((s) => {
    if (s.budgetWarnedIds.has(id)) return {};
    const next = new Set(s.budgetWarnedIds);
    next.add(id);
    return { budgetWarnedIds: next };
  }),

  fetchGitInfo: async (terminalId) => {
    const instance = get().terminals.get(terminalId);
    if (!instance) return;

    try {
      const info = await invoke<WorktreeDetectResult>('get_worktree_info', {
        path: instance.config.working_directory,
      });
      set((state) => {
        const newCache = new Map(state.gitInfoCache);
        newCache.set(terminalId, info);
        return { gitInfoCache: newCache };
      });
    } catch {
      // Silently ignore - non-git dirs or git not installed
    }

    const task = instance.config.task;
    if (!task) return;
    try {
      const status = await invoke<TaskStatus>('get_task_status', { worktreePath: task.worktreePath });
      set((state) => {
        const next = new Map(state.taskDivergence);
        next.set(terminalId, { ahead: status.ahead, behind: status.behind });
        return { taskDivergence: next };
      });
    } catch {
      // Badge refresh is best-effort: a finished or hand-deleted task worktree
      // simply keeps its last known counts until the terminal closes.
    }
  },

  reorderTerminals: (orderedIds) => set((state) => {
    // Rebuild the Map in the new order. JS Maps preserve insertion order,
    // so consumers that iterate via `Array.from(terminals.values())` pick up
    // the reorder automatically. Unknown ids are dropped and missing ids are
    // appended at the end to stay resilient to races with concurrent adds.
    const next = new Map<string, TerminalInstance>();
    for (const id of orderedIds) {
      const inst = state.terminals.get(id);
      if (inst) next.set(id, inst);
    }
    for (const [id, inst] of state.terminals) {
      if (!next.has(id)) next.set(id, inst);
    }
    return { terminals: next };
  }),

  adoptTerminal: (config, restoredOutput) => {
    const replayToken = get().terminals.has(config.id) ? null : {};
    if (replayToken) {
      pendingOutputBuffers.delete(config.id);
      replayRequests.set(config.id, replayToken);
    }
    const claudeArgs = config.claude_args || [];
    let model: string | undefined;
    let effort: string | undefined;
    const isWorktree = claudeArgs.includes('--worktree');
    for (let i = 0; i < claudeArgs.length; i++) {
      if (claudeArgs[i] === '--model' && i + 1 < claudeArgs.length) model = claudeArgs[i + 1];
      if (claudeArgs[i] === '--effort' && i + 1 < claudeArgs.length) effort = claudeArgs[i + 1];
    }

    set((state) => {
      const newTerminals = new Map(state.terminals);
      // Guard against a duplicate adopt (e.g. the transfer event firing twice):
      // keep the existing instance - clobbering it would drop a live xterm.
      if (!newTerminals.has(config.id)) {
        newTerminals.set(config.id, { config, xterm: null, restoredOutput, model, effort, isWorktree });
      }
      return { terminals: newTerminals, activeTerminalId: config.id };
    });

    if (replayToken) replayTransferredOutput(config.id, replayToken);
    get().fetchGitInfo(config.id);
  },

  detachTerminals: (ids) => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);

    set((state) => {
      const newTerminals = new Map(state.terminals);
      const newUnread = new Set(state.unreadTerminalIds);
      const newGitCache = new Map(state.gitInfoCache);
      const newChildren = new Map(state.scriptChildren);

      for (const id of ids) {
        const inst = newTerminals.get(id);
        if (inst?.xterm) inst.xterm.dispose();
        newTerminals.delete(id);
        newUnread.delete(id);
        newGitCache.delete(id);
        clearTerminalActivity(id);
        // The tab is moving to another window; that window's store owns any
        // replay from here on. Drop our copy so future events for this id
        // (still fired globally by the shared backend) don't buffer forever.
        pendingOutputBuffers.delete(id);

        // Drop any local script-child entry for this parent. We do NOT close
        // the child's PTY - detach never kills processes - but the child isn't
        // carried across windows in v1, so just forget it locally.
        const childId = newChildren.get(id);
        if (childId) {
          const childInst = newTerminals.get(childId);
          if (childInst?.xterm) childInst.xterm.dispose();
          newTerminals.delete(childId);
          newChildren.delete(id);
          pendingOutputBuffers.delete(childId);
        }
      }

      // If the active tab was detached, fall back to a remaining main-tab
      // terminal (never a script child or bottom-pane shell).
      let nextActive = state.activeTerminalId;
      if (nextActive && idSet.has(nextActive)) {
        const remainingIds = Array.from(newTerminals.values())
          .filter((t) => !t.scriptParentId && !t.isShellTerminal)
          .map((t) => t.config.id);
        nextActive = remainingIds[0] || null;
      }

      return {
        terminals: newTerminals,
        unreadTerminalIds: newUnread,
        gitInfoCache: newGitCache,
        scriptChildren: newChildren,
        activeTerminalId: nextActive,
      };
    });
  },

  runScript: async (parentId, scriptName, cwdOverride) => {
    const parent = get().terminals.get(parentId);
    if (!parent) throw new Error('Parent terminal not found');

    // Replace any existing script child for this parent so the UI always
    // shows the most recently-requested script.
    const existingChildId = get().scriptChildren.get(parentId);
    if (existingChildId) {
      await get().closeScript(parentId).catch(() => {});
    }

    const cwd = cwdOverride ?? parent.config.working_directory;
    const config = await invoke<TerminalConfig>('create_script_terminal', {
      cwd,
      scriptName,
    });

    set((state) => {
      const nextTerminals = new Map(state.terminals);
      nextTerminals.set(config.id, {
        config,
        xterm: null,
        isWorktree: false,
        scriptName,
        scriptParentId: parentId,
      });
      const nextChildren = new Map(state.scriptChildren);
      nextChildren.set(parentId, config.id);
      return { terminals: nextTerminals, scriptChildren: nextChildren };
    });

    return config.id;
  },

  closeScript: async (parentId) => {
    const childId = get().scriptChildren.get(parentId);
    if (!childId) return;
    try {
      await invoke('close_terminal', { id: childId });
    } catch {
      // Already closed - fall through to store cleanup.
    }
    pendingOutputBuffers.delete(childId);
    set((state) => {
      const nextTerminals = new Map(state.terminals);
      const inst = nextTerminals.get(childId);
      if (inst?.xterm) inst.xterm.dispose();
      nextTerminals.delete(childId);
      const nextChildren = new Map(state.scriptChildren);
      nextChildren.delete(parentId);
      const nextStates = new Map(state.terminalStates);
      nextStates.delete(childId);
      return { terminals: nextTerminals, scriptChildren: nextChildren, terminalStates: nextStates };
    });
  },

  openShellTerminal: async (label, cwd) => {
    const config = await invoke<TerminalConfig>('create_shell_terminal', { label, cwd });
    set((state) => {
      const nextTerminals = new Map(state.terminals);
      nextTerminals.set(config.id, {
        config,
        xterm: null,
        isWorktree: false,
        isShellTerminal: true,
      });
      return {
        terminals: nextTerminals,
        bottomTerminalIds: [...state.bottomTerminalIds, config.id],
        activeBottomTerminalId: config.id,
      };
    });
    return config.id;
  },

  closeShellTerminal: async (id) => {
    try {
      await invoke('close_terminal', { id });
    } catch {
      // Already gone - fall through to store cleanup.
    }
    pendingOutputBuffers.delete(id);
    set((state) => {
      const nextTerminals = new Map(state.terminals);
      const inst = nextTerminals.get(id);
      if (inst?.xterm) inst.xterm.dispose();
      nextTerminals.delete(id);
      const nextIds = state.bottomTerminalIds.filter((x) => x !== id);
      let nextActive: string | null = state.activeBottomTerminalId;
      if (nextActive === id) {
        const removedIdx = state.bottomTerminalIds.indexOf(id);
        if (nextIds.length === 0) {
          nextActive = null;
        } else {
          const fallbackIdx = Math.min(Math.max(removedIdx, 0), nextIds.length - 1);
          nextActive = nextIds[fallbackIdx];
        }
      }
      const nextStates = new Map(state.terminalStates);
      nextStates.delete(id);
      return {
        terminals: nextTerminals,
        bottomTerminalIds: nextIds,
        activeBottomTerminalId: nextActive,
        terminalStates: nextStates,
      };
    });
  },

  setActiveBottomTerminal: (id) => set({ activeBottomTerminalId: id }),
}));
