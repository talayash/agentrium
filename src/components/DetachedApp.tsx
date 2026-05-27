import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useTerminalStore } from '../store/terminalStore';
import type { TerminalConfig } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import { TerminalView } from './TerminalView';
import { ToastContainer } from './ToastContainer';
import { getWindowMode } from '../lib/windowMode';
import { useTabDrag } from '../hooks/useTabDrag';
import { installTransferReceiver, requestTransfer } from '../lib/tabTransfer';
import {
  applyAccentColor,
  applyThemeMode,
  applyDensity,
  applyReduceMotion,
  applyUiFontScale,
} from '../lib/accentTheme';

/**
 * Minimal layout for a torn-off ("detached") window. It renders only the
 * terminals it was handed — the PTYs live in the shared backend, so this window
 * just binds xterms to ids and receives the globally-broadcast `terminal-output`
 * events. It deliberately skips the setup wizard, session restore, auto-save,
 * telemetry and notifications (the main window owns those) to avoid duplicate
 * side-effects across windows.
 */
export function DetachedApp() {
  const terminals = useTerminalStore((s) => s.terminals);
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
  const closeTerminal = useTerminalStore((s) => s.closeTerminal);
  const adoptTerminal = useTerminalStore((s) => s.adoptTerminal);
  const detachTerminals = useTerminalStore((s) => s.detachTerminals);
  const handleTerminalOutput = useTerminalStore((s) => s.handleTerminalOutput);
  const updateTerminalStatus = useTerminalStore((s) => s.updateTerminalStatus);

  const { label } = getWindowMode();
  const { isSelected, onTabClick, dropIndex, tabDragProps, containerDragProps } = useTabDrag(label, 'detached');

  const [closePrompt, setClosePrompt] = useState(false);
  // Set true once the user (or auto-close) has decided how to close, so the
  // onCloseRequested interceptor lets the next close() through without prompting.
  const confirmedRef = useRef(false);
  // Becomes true after the initial adoption runs, so the empty-window auto-close
  // doesn't fire during the brief pre-adoption window at startup.
  const hasAdoptedRef = useRef(false);

  // Apply the persisted appearance settings (the main window does this via its
  // own effects, which we don't run here). Read once from the shared store.
  const themeMode = useAppStore((s) => s.themeMode);
  const uiDensity = useAppStore((s) => s.uiDensity);
  const accentColorHex = useAppStore((s) => s.accentColorHex);
  const uiReduceMotion = useAppStore((s) => s.uiReduceMotion);
  const uiFontScale = useAppStore((s) => s.uiFontScale);
  useEffect(() => {
    applyThemeMode(themeMode);
    applyDensity(uiDensity);
    applyAccentColor(accentColorHex);
    applyReduceMotion(uiReduceMotion);
    applyUiFontScale(uiFontScale);
  }, [themeMode, uiDensity, accentColorHex, uiReduceMotion, uiFontScale]);

  // Adopt the terminals named in the URL: fetch their configs from the shared
  // backend (no spawn) and seed prior scrollback from the session log, mirroring
  // session restore.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { initialIds } = getWindowMode();
      try {
        if (initialIds.length > 0) {
          const all = await invoke<TerminalConfig[]>('get_terminals');
          const byId = new Map(all.map((c) => [c.id, c]));
          for (const id of initialIds) {
            const cfg = byId.get(id);
            if (!cfg) continue;
            let log: string | undefined;
            try {
              log = (await invoke<string | null>('get_session_log', { terminalId: id })) ?? undefined;
            } catch {
              // No log captured (e.g. plain shell) — adopt without scrollback.
            }
            if (cancelled) return;
            adoptTerminal(cfg, log);
          }
        }
      } catch (err) {
        console.error('[detached] failed to adopt terminals:', err);
      } finally {
        if (!cancelled) hasAdoptedRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adoptTerminal]);

  // Live output for owned terminals. handleTerminalOutput is a no-op for ids
  // this window doesn't own (it only writes when an xterm is bound), so the
  // global broadcast is safe to listen to here.
  useEffect(() => {
    const unlisten = listen<{ id: string; data: number[] }>('terminal-output', (event) => {
      handleTerminalOutput(event.payload.id, new Uint8Array(event.payload.data));
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [handleTerminalOutput]);

  // Minimal finished handling: mark stopped. No toast/notify/summarize — the
  // main window runs the full handler.
  useEffect(() => {
    const unlisten = listen<{ id: string }>('terminal-finished', (event) => {
      updateTerminalStatus(event.payload.id, 'Stopped');
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [updateTerminalStatus]);

  // Accept tabs dropped INTO this window, and release tabs that get transferred
  // away (or returned to main). installTransferReceiver returns an unlisten fn.
  useEffect(
    () => installTransferReceiver(label, adoptTerminal, detachTerminals),
    [label, adoptTerminal, detachTerminals],
  );

  const ownedList = useMemo(
    () =>
      Array.from(terminals.values())
        .filter((t) => !t.scriptParentId && !t.isShellTerminal)
        .map((t) => t.config),
    [terminals],
  );

  const appWindow = getCurrentWindow();

  const forceClose = () => {
    confirmedRef.current = true;
    appWindow.close();
  };

  // Intercept the OS close button → ask what to do with the live terminals,
  // unless a choice was already made (forceClose) or it's an auto-close.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onCloseRequested((event) => {
        if (confirmedRef.current) return; // let the close proceed
        event.preventDefault();
        setClosePrompt(true);
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, []);

  // Once this window has adopted its tabs and later becomes empty (last tab
  // dragged out or returned), close it automatically — no prompt.
  useEffect(() => {
    if (hasAdoptedRef.current && ownedList.length === 0) {
      forceClose();
    }
    // forceClose is stable enough for this guard; deliberately keyed on count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownedList.length]);

  const returnToMain = async () => {
    const ids = ownedList.map((t) => t.id);
    try {
      await requestTransfer('main', ids, label);
    } catch {
      // best effort — fall through to close
    }
    forceClose();
  };

  const closeAllTerminals = async () => {
    for (const t of ownedList) {
      try {
        await closeTerminal(t.id);
      } catch {
        // already gone
      }
    }
    forceClose();
  };

  return (
    <div className="h-screen w-screen bg-bg-primary flex flex-col overflow-hidden rounded-[4px] ring-1 ring-black/60">
      {/* Slim titlebar: drag region + tabs + window controls */}
      <div
        onMouseDown={(e) => {
          if (e.buttons === 1 && (e.target as HTMLElement).closest('.no-drag') === null) {
            appWindow.startDragging();
          }
        }}
        className="h-9 bg-elevation-1 flex items-center justify-between border-b border-[var(--ij-divider)] select-none"
      >
        <ul
          {...containerDragProps}
          className="flex items-center overflow-x-auto scrollbar-none flex-1 min-w-0 no-drag list-none m-0 p-0"
        >
          {ownedList.map((terminal, index) => {
            const isActive = activeTerminalId === terminal.id;
            const selected = isSelected(terminal.id);
            return (
              <li key={terminal.id} className="flex items-center flex-shrink-0">
                {dropIndex === index && (
                  <span className="w-[2px] h-5 bg-accent-primary rounded-full flex-shrink-0" aria-hidden />
                )}
                <div
                  role="tab"
                  tabIndex={0}
                  aria-selected={isActive}
                  {...tabDragProps(terminal.id, index)}
                  onClick={(e) => onTabClick(e, terminal.id)}
                  className={`group relative flex items-center gap-2 px-3 h-9 text-[12px] cursor-pointer select-none transition-colors ${
                    isActive
                      ? 'bg-elevation-0 text-text-primary'
                      : 'hover:bg-white/[0.045] text-text-secondary'
                  } ${selected && !isActive ? 'ring-1 ring-inset ring-accent-primary/40' : ''}`}
                >
                  {isActive && (
                    <span className="absolute left-2 right-2 bottom-0 h-[2px] rounded-t bg-accent-primary" />
                  )}
                  {terminal.color_tag && (
                    <div className={`w-2 h-2 rounded-full ${terminal.color_tag} flex-shrink-0`} />
                  )}
                  <span className="max-w-[140px] truncate">{terminal.nickname || terminal.label}</span>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTerminal(terminal.id);
                    }}
                    className="p-0.5 rounded hover:bg-white/[0.08] text-text-tertiary hover:text-text-primary opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                    title="Close"
                  >
                    <X size={12} />
                  </span>
                </div>
              </li>
            );
          })}
          {dropIndex === ownedList.length && ownedList.length > 0 && (
            <li className="flex items-center flex-shrink-0" aria-hidden>
              <span className="w-[2px] h-5 bg-accent-primary rounded-full flex-shrink-0" />
            </li>
          )}
        </ul>

        {/* Window controls (Windows-style; mac uses traffic lights but keep it
            simple and consistent for the detached window) */}
        <div className="flex items-center no-drag">
          <button
            onClick={() => appWindow.minimize()}
            className="w-10 h-9 flex items-center justify-center text-text-secondary hover:bg-white/[0.06] transition-colors"
            title="Minimize"
          >
            <span className="w-2.5 h-px bg-current" />
          </button>
          <button
            onClick={() => appWindow.toggleMaximize()}
            className="w-10 h-9 flex items-center justify-center text-text-secondary hover:bg-white/[0.06] transition-colors"
            title="Maximize"
          >
            <span className="w-2.5 h-2.5 border border-current rounded-[1px]" />
          </button>
          <button
            onClick={() => appWindow.close()}
            className="w-10 h-9 flex items-center justify-center text-text-secondary hover:bg-red-500 hover:text-white transition-colors"
            title="Close"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Active terminal body */}
      <div className="flex-1 relative">
        {activeTerminalId && terminals.has(activeTerminalId) ? (
          <div key={activeTerminalId} className="absolute inset-0 flex flex-col">
            <TerminalView terminalId={activeTerminalId} />
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-text-tertiary text-[12px]">
            No terminal in this window
          </div>
        )}
      </div>

      {/* "Ask each time" close dialog */}
      {closePrompt && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-bg-elevated ring-1 ring-white/[0.08] rounded-md shadow-elevation-4 p-4 w-[380px]">
            <h3 className="text-text-primary text-[13px] font-semibold mb-1">Close this window?</h3>
            <p className="text-text-tertiary text-[12px] mb-4">
              {ownedList.length} terminal{ownedList.length === 1 ? '' : 's'}{' '}
              {ownedList.length === 1 ? 'is' : 'are'} open here. Return{' '}
              {ownedList.length === 1 ? 'it' : 'them'} to the main window, or close{' '}
              {ownedList.length === 1 ? 'it' : 'them'} entirely?
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setClosePrompt(false)}
                className="px-3 h-8 text-text-secondary hover:text-text-primary hover:bg-white/[0.04] rounded-md text-[12px] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  void closeAllTerminals();
                }}
                className="px-3 h-8 bg-red-500 hover:bg-red-600 text-white rounded-md text-[12px] font-medium transition-colors"
              >
                Close terminals
              </button>
              <button
                onClick={() => {
                  void returnToMain();
                }}
                className="px-3 h-8 bg-accent-primary hover:bg-accent-secondary text-white rounded-md text-[12px] font-medium transition-colors"
              >
                Return to main
              </button>
            </div>
          </div>
        </div>
      )}

      <ToastContainer />
    </div>
  );
}
