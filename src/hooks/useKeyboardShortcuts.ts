import { useEffect, useRef } from 'react';
import { useAppStore, DEFAULT_TERMINAL_FONT_SIZE } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';
import { usePreviewStore } from '../store/previewStore';
import { toast } from '../store/toastStore';
import { captureClaudeInput } from '../lib/terminalInput';
import { reportInvokeFailure } from '../lib/errorReporter';
import { readClipboardText } from '../lib/clipboard';

/**
 * Return true when the focused element is an editable surface that is NOT
 * inside an xterm terminal - i.e., a Settings/modal input, a Monaco editor,
 * or the global search box. In those cases we must let key events pass
 * through to the native control instead of hijacking them for terminal zoom.
 */
function isFocusInNonTerminalEditable(): boolean {
  const el = document.activeElement;
  if (!el || el === document.body) return false;
  // xterm's hidden textarea always lives inside an .xterm container - let
  // shortcuts through when the user is "in" a terminal.
  if (el.closest('.xterm')) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

export function useKeyboardShortcuts() {
  // Use refs for values that change frequently to avoid re-registering the listener
  const terminalsRef = useRef(useTerminalStore.getState().terminals);
  const activeIdRef = useRef(useTerminalStore.getState().activeTerminalId);
  const gridModeRef = useRef(useAppStore.getState().gridMode);

  useEffect(() => {
    const unsubTerminal = useTerminalStore.subscribe((state) => {
      terminalsRef.current = state.terminals;
      activeIdRef.current = state.activeTerminalId;
    });
    const unsubApp = useAppStore.subscribe((state) => {
      gridModeRef.current = state.gridMode;
    });
    return () => {
      unsubTerminal();
      unsubApp();
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't hijack keys while the user is typing in a non-terminal editable
      // surface (Settings/modal input, Monaco editor, global search box). These
      // are app-global accelerators - in a text field the native control must
      // win, otherwise Ctrl+P, Ctrl+W, F2 (Monaco rename), Ctrl+Shift+F/S/D,
      // etc. get stolen mid-edit. The helper returns false for xterm's own
      // textarea, so terminal-focused shortcuts still work.
      if (isFocusInNonTerminalEditable()) return;

      const ctrl = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;

      // Swallow F5 and Ctrl+R globally. WebView2's default reloads the
      // top-level document, which throws away all open terminals (they
      // aren't persisted). If the preview panel is open, route to the
      // preview reload instead.
      if (e.key === 'F5' || (ctrl && !shift && (e.key === 'r' || e.key === 'R'))) {
        e.preventDefault();
        const previewOpen = usePreviewStore.getState().globalOpen;
        const activeId = activeIdRef.current;
        if (previewOpen && activeId) {
          usePreviewStore.getState().reload(activeId);
        }
        return;
      }

      if (ctrl && shift && e.key === 'N') {
        e.preventDefault();
        useAppStore.getState().openNewTerminalModal();
      }

      // Command Palette: Ctrl+P
      if (ctrl && e.key === 'p') {
        e.preventDefault();
        useAppStore.getState().toggleCommandPalette();
      }

      // Snippets: Ctrl+Shift+S
      if (ctrl && shift && e.key === 'S') {
        e.preventDefault();
        useAppStore.getState().openSnippetsModal();
      }

      // Prompt Editor: Ctrl+Shift+E - compose a prompt for the active terminal,
      // seeded with whatever is already typed in its input line. Can be turned
      // off in Settings (the status-bar pencil still works).
      if (ctrl && shift && e.key === 'E' && useAppStore.getState().promptEditorShortcutEnabled) {
        e.preventDefault();
        const activeId = activeIdRef.current;
        const term = activeId ? terminalsRef.current.get(activeId)?.xterm : undefined;
        const seed = term ? captureClaudeInput(term) : '';
        useAppStore.getState().openPromptEditor(activeId, seed);
      }

      // Paste as file: Ctrl+Shift+V
      if (ctrl && shift && e.key === 'V') {
        e.preventDefault();
        const activeId = activeIdRef.current;
        (async () => {
          let clipboardText = '';
          try { clipboardText = await readClipboardText(); } catch { /* clipboard may be unavailable — open drawer with empty seed */ }
          useAppStore.getState().openPasteDrawer({
            content: clipboardText,
            targetTerminalId: activeId,
          });
        })();
      }

      // Preview panel toggle: Ctrl+Alt+P (Ctrl+Shift+V and Ctrl+Shift+G are taken).
      if (ctrl && e.altKey && !shift && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        usePreviewStore.getState().toggleGlobal();
      }

      // Split View: Ctrl+\
      if (ctrl && e.key === '\\') {
        e.preventDefault();
        const { splitMode, clearSplit, setSplitTerminals, setSplitMode } = useAppStore.getState();
        if (splitMode) {
          clearSplit();
        } else {
          const terminals = terminalsRef.current;
          const activeId = activeIdRef.current;
          const terminalIds = Array.from(terminals.keys());
          if (terminalIds.length >= 2 && activeId) {
            const otherIds = terminalIds.filter(id => id !== activeId);
            if (otherIds.length > 0) {
              setSplitTerminals([activeId, otherIds[0]]);
              setSplitMode(true);
            }
          }
        }
      }

      // Global file/content search (VS Code style): Ctrl+Shift+F
      if (ctrl && shift && e.key === 'F') {
        e.preventDefault();
        useAppStore.getState().toggleGlobalSearch();
      }

      if (ctrl && e.key === 'b') {
        e.preventDefault();
        useAppStore.getState().toggleSidebar();
      }

      if (ctrl && e.key === 'w') {
        e.preventDefault();
        const activeId = activeIdRef.current;
        if (activeId) {
          useTerminalStore.getState().closeTerminal(activeId).catch((err) => {
            toast.error('Close failed', 'Could not close the terminal.');
            reportInvokeFailure('close_terminal', err);
          });
        }
      }

      // Duplicate active terminal: Ctrl+Shift+D
      if (ctrl && shift && e.key === 'D') {
        e.preventDefault();
        const activeId = activeIdRef.current;
        if (activeId) {
          const instance = terminalsRef.current.get(activeId);
          if (instance) {
            const { label, working_directory, claude_args, env_vars, color_tag, nickname, agent } = instance.config;
            // createTerminal rethrows on spawn failure - without this catch the
            // duplicate silently doesn't appear and the rejection goes unhandled.
            useTerminalStore.getState().createTerminal(
              label,
              working_directory,
              claude_args,
              env_vars,
              color_tag ?? undefined,
              nickname ?? undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              agent,
            ).catch((err) => {
              toast.error('Duplicate failed', 'Could not start the new terminal.');
              reportInvokeFailure('create_terminal', err);
            });
          }
        }
      }

      if (ctrl && e.key === ',') {
        e.preventDefault();
        useAppStore.getState().openSettings();
      }

      if (e.key === 'F1') {
        e.preventDefault();
        useAppStore.getState().toggleHints();
      }

      if (e.key === 'F2') {
        e.preventDefault();
        useAppStore.getState().toggleChanges();
      }

      if (e.key === 'F4') {
        e.preventDefault();
        useAppStore.getState().toggleOrchestration();
      }

      // Claude Config: F6
      if (e.key === 'F6') {
        e.preventDefault();
        const state = useAppStore.getState();
        if (state.claudeConfigOpen) {
          state.closeClaudeConfig();
        } else {
          state.openClaudeConfig();
        }
      }

      // Session Timeline: F7
      if (e.key === 'F7') {
        e.preventDefault();
        useAppStore.getState().toggleSessionTimeline();
      }

      // Memory Editor: F8
      if (e.key === 'F8') {
        e.preventDefault();
        const state = useAppStore.getState();
        if (state.memoryEditorOpen) {
          state.closeMemoryEditor();
        } else {
          state.openMemoryEditor();
        }
      }

      // Toggle Grid Mode: Ctrl+G
      if (ctrl && e.key === 'g') {
        e.preventDefault();
        useAppStore.getState().toggleGridMode();
      }

      // Push modal: Ctrl+Shift+K (IntelliJ parity)
      if (ctrl && shift && e.key === 'K') {
        e.preventDefault();
        const activeId = activeIdRef.current;
        if (!activeId) {
          toast.info('Push', 'No active terminal');
          return;
        }
        const gitInfo = useTerminalStore.getState().gitInfoCache.get(activeId);
        if (!gitInfo?.is_git_repo) {
          toast.info('Push', 'Not in a git repository');
          return;
        }
        const terminal = terminalsRef.current.get(activeId);
        const path = terminal?.config.working_directory;
        if (!path) {
          toast.info('Push', 'No working directory');
          return;
        }
        useAppStore.getState().openPushModal(path);
      }

      // Worktree Modal: Ctrl+Shift+W
      if (ctrl && shift && e.key === 'W') {
        e.preventDefault();
        const activeId = activeIdRef.current;
        if (activeId) {
          const gitInfo = useTerminalStore.getState().gitInfoCache.get(activeId);
          if (gitInfo?.is_git_repo) {
            const terminal = terminalsRef.current.get(activeId);
            const repoPath = gitInfo.is_worktree && gitInfo.main_repo_path
              ? gitInfo.main_repo_path
              : terminal?.config.working_directory || '';
            useAppStore.getState().openWorktreeModal(repoPath);
          }
        }
      }

      // Add current terminal to grid: Ctrl+Shift+G
      if (ctrl && shift && e.key === 'G') {
        e.preventDefault();
        const activeId = activeIdRef.current;
        if (activeId) {
          useAppStore.getState().addToGrid(activeId);
          if (!gridModeRef.current) useAppStore.getState().toggleGridMode();
        }
      }

      if (ctrl && e.key === 'Tab') {
        e.preventDefault();
        const terminals = terminalsRef.current;
        const activeId = activeIdRef.current;
        const terminalIds = Array.from(terminals.keys());
        if (terminalIds.length > 0 && activeId) {
          const currentIndex = terminalIds.indexOf(activeId);
          const nextIndex = shift
            ? (currentIndex - 1 + terminalIds.length) % terminalIds.length
            : (currentIndex + 1) % terminalIds.length;
          useTerminalStore.getState().setActiveTerminal(terminalIds[nextIndex]);
        }
      }

      // Terminal font zoom. Ctrl+= / Ctrl++ / Ctrl+- / Ctrl+0.
      // Skip when the user is in a non-terminal editable surface so that
      // e.g. Ctrl+- in a Settings input still selects characters natively.
      if (ctrl && !shift && (e.key === '=' || e.key === '-' || e.key === '0')) {
        if (isFocusInNonTerminalEditable()) return;
        e.preventDefault();
        const { terminalFontSize, setTerminalFontSize } = useAppStore.getState();
        if (e.key === '=') setTerminalFontSize(terminalFontSize + 1);
        else if (e.key === '-') setTerminalFontSize(terminalFontSize - 1);
        else setTerminalFontSize(DEFAULT_TERMINAL_FONT_SIZE);
        return;
      }
      // Ctrl++ (with Shift) - same as Ctrl+= for users who reflexively press shift.
      if (ctrl && shift && e.key === '+') {
        if (isFocusInNonTerminalEditable()) return;
        e.preventDefault();
        const { terminalFontSize, setTerminalFontSize } = useAppStore.getState();
        setTerminalFontSize(terminalFontSize + 1);
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
}
