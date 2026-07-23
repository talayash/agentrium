import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { Terminal } from '@xterm/xterm';
import type { WorktreeDetectResult } from '../types/git';
import { markTerminalActive, clearTerminalActivity } from '../lib/terminalActivity';
import { chunkUtf8Bytes } from '../lib/chunkUtf8';
import type { SessionState } from '../lib/terminalState';
import { mergeMetrics, emptyMetrics, type SessionMetrics, type TerminalMetricsPayload } from '../lib/sessionMetrics';
import { usePreviewStore, type PreviewState } from './previewStore';
import { detectFramework, type FrameworkHint } from '../lib/preview/framework';

// Stay safely under the backend's 64 KB per-write cap so very large pastes
// (multi-hundred KB) don't hit "Write payload too large".
const TERMINAL_WRITE_CHUNK_BYTES = 60 * 1024;

/**
 * Best-effort framework detection for the Preview panel. Reads the terminal's
 * cwd/package.json via the existing `list_package_scripts` IPC (no new Rust
 * command or fs plugin required), reconstructs a minimal package.json shape,
 * and seeds the preview store with the detected framework hint.
 *
 * The IPC only exposes `scripts.*` — not `dependencies` — so detection here is
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
    // no package.json, invalid JSON, path not trusted — silent.
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
  /** UUID of the Claude Code conversation this terminal is bound to. Populated
   *  by the backend a few seconds after spawn (snapshot/diff of
   *  ~/.claude/projects/<encoded-cwd>/*.jsonl) and used by session restore to
   *  re-attach via `claude --resume <id>`. */
  claude_session_id?: string | null;
}

export interface LoopInfo {
  interval: string;
  prompt: string;
}

interface TerminalInstance {
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
  updateNickname: (id: string, nickname: string) => Promise<void>;
  writeToTerminal: (id: string, data: string) => Promise<void>;
  resizeTerminal: (id: string, cols: number, rows: number) => Promise<void>;
  setXterm: (id: string, xterm: Terminal | null) => void;
  stashTerminalBuffer: (id: string, data: string) => void;
  handleTerminalOutput: (id: string, data: Uint8Array) => void;
  updateTerminalStatus: (id: string, status: TerminalConfig['status']) => void;
  setLoopMode: (id: string, info: LoopInfo | null) => void;
  setSessionSummary: (id: string, summary: string | null) => void;
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
  //     their xterms WITHOUT calling close_terminal — the PTY keeps running so
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
  scriptChildren: new Map(),
  bottomTerminalIds: [],
  activeBottomTerminalId: null,

  createTerminal: async (label, workingDirectory, claudeArgs, envVars, colorTag, nickname, restoredOutput, resumeSessionId, continueRecent, previewInit) => {
    try {
      const { useAppStore } = await import('./appStore');
      const costTracking = useAppStore.getState().costTrackingEnabled;
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
      // the caller didn't pass previewInit — that way an ad-hoc terminal in a
      // Vite/Next repo gets its hint auto-detected.
      void seedFrameworkHint(config.id, workingDirectory);

      return config.id;
    } catch (error) {
      console.error('Failed to create terminal:', error);
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
      console.error('Failed to create shell terminal tab:', error);
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
    } catch {
      // ignore - cleanup is best-effort
    }

    await invoke('close_terminal', { id });

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
    const bytes = new TextEncoder().encode(data);
    if (bytes.length <= TERMINAL_WRITE_CHUNK_BYTES) {
      await invoke('write_to_terminal', { id, data: Array.from(bytes) });
      return;
    }
    for (const chunk of chunkUtf8Bytes(bytes, TERMINAL_WRITE_CHUNK_BYTES)) {
      await invoke('write_to_terminal', { id, data: Array.from(chunk) });
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
      set((state) => {
        const newTerminals = new Map(state.terminals);
        const inst = newTerminals.get(id);
        if (inst) {
          inst.xterm = null;
        }
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

    set((state) => {
      const newTerminals = new Map(state.terminals);
      const inst = newTerminals.get(id);
      if (inst) {
        inst.xterm = xterm;
        delete inst.restoredOutput; // Free memory
        delete inst.carryOverBuffer; // Replayed - drop the snapshot
      }
      return { terminals: newTerminals };
    });
  },

  stashTerminalBuffer: (id, data) => {
    set((state) => {
      const inst = state.terminals.get(id);
      // No-op if the terminal is gone (permanently closed) - nothing to carry.
      if (!inst) return state;
      const newTerminals = new Map(state.terminals);
      const next = newTerminals.get(id);
      if (next) {
        next.carryOverBuffer = data;
      }
      return { terminals: newTerminals };
    });
  },

  handleTerminalOutput: (id, data) => {
    const state = get();
    const instance = state.terminals.get(id);
    if (instance?.xterm) {
      // Guard against a dispose/output race: if the view unmounted between the
      // store read and this write, xterm.write() on a disposed instance throws.
      // Swallow it rather than surface an UnhandledRejection in the event loop.
      try {
        instance.xterm.write(data);
      } catch {
        /* terminal disposed - drop this chunk */
      }
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
    set((state) => {
      const newTerminals = new Map(state.terminals);
      const instance = newTerminals.get(id);
      if (instance) {
        newTerminals.set(id, { ...instance, loopInfo: info });
      }
      return { terminals: newTerminals };
    });
  },

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
      // keep the existing instance — clobbering it would drop a live xterm.
      if (!newTerminals.has(config.id)) {
        newTerminals.set(config.id, { config, xterm: null, restoredOutput, model, effort, isWorktree });
      }
      return { terminals: newTerminals, activeTerminalId: config.id };
    });

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

        // Drop any local script-child entry for this parent. We do NOT close
        // the child's PTY — detach never kills processes — but the child isn't
        // carried across windows in v1, so just forget it locally.
        const childId = newChildren.get(id);
        if (childId) {
          const childInst = newTerminals.get(childId);
          if (childInst?.xterm) childInst.xterm.dispose();
          newTerminals.delete(childId);
          newChildren.delete(id);
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
