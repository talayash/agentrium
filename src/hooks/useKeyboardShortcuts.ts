import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';

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
      const ctrl = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;

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

      // Paste as file: Ctrl+Shift+V
      if (ctrl && shift && e.key === 'V') {
        e.preventDefault();
        const activeId = activeIdRef.current;
        (async () => {
          let clipboardText = '';
          try { clipboardText = await navigator.clipboard.readText(); } catch { /* ignore */ }
          useAppStore.getState().openPasteDrawer({
            content: clipboardText,
            targetTerminalId: activeId,
          });
        })();
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
        if (activeId) useTerminalStore.getState().closeTerminal(activeId);
      }

      // Duplicate active terminal: Ctrl+Shift+D
      if (ctrl && shift && e.key === 'D') {
        e.preventDefault();
        const activeId = activeIdRef.current;
        if (activeId) {
          const instance = terminalsRef.current.get(activeId);
          if (instance) {
            const { label, working_directory, claude_args, env_vars, color_tag, nickname } = instance.config;
            useTerminalStore.getState().createTerminal(
              label,
              working_directory,
              claude_args,
              env_vars,
              color_tag ?? undefined,
              nickname ?? undefined,
            );
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
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
}
