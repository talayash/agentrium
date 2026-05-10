import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useTerminalStore } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import { toast } from '../store/toastStore';
import { TerminalSearch } from './TerminalSearch';
import { TerminalStatusBar } from './TerminalStatusBar';
import '@xterm/xterm/css/xterm.css';

function formatDroppedPath(path: string): string {
  // Strip control characters — macOS/Linux filenames can legally contain
  // newlines, which would otherwise auto-execute whatever follows in the PTY
  // without the user pressing Enter.
  const sanitized = path.replace(/[\x00-\x1f\x7f]/g, '');
  const isWindowsPath = /^([a-zA-Z]:[\\/]|\\\\)/.test(sanitized);
  if (isWindowsPath) {
    // cmd/pwsh don't expand $ or backtick and don't process backslash escapes,
    // so preserve backslashes as path separators and only escape embedded ".
    if (/[\s"'`$&|;<>()*?]/.test(sanitized)) {
      return `"${sanitized.replace(/"/g, '\\"')}"`;
    }
    return sanitized;
  }
  // POSIX path → likely bash/zsh. Single quotes suppress all expansion; an
  // embedded single quote is closed, escaped, and reopened.
  if (/[\s"'`$&|;<>()*?\\]/.test(sanitized)) {
    return `'${sanitized.replace(/'/g, "'\\''")}'`;
  }
  return sanitized;
}

interface TerminalViewProps {
  terminalId: string;
}

export function TerminalView({ terminalId }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const [searchVisible, setSearchVisible] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  // Narrow selector — only re-render when THIS terminal's instance changes,
  // not on every output-unread-set update for other terminals.
  const instance = useTerminalStore((s) => s.terminals.get(terminalId));
  // Stable action refs: these are static on the store so pulling them via
  // getState avoids putting them in the effect dep array (which was causing
  // the xterm instance to tear down on every unrelated store update).
  const writeToTerminal = useTerminalStore.getState().writeToTerminal;
  const resizeTerminal = useTerminalStore.getState().resizeTerminal;
  const setXterm = useTerminalStore.getState().setXterm;

  const toggleSearch = useCallback(() => {
    setSearchVisible(prev => !prev);
  }, []);

  useEffect(() => {
    if (!containerRef.current || !instance) return;

    const terminal = new Terminal({
      theme: {
        background: '#101010',
        foreground: '#E5E5E5',
        cursor: '#E5E5E5',
        cursorAccent: '#101010',
        selectionBackground: 'rgba(59, 130, 246, 0.25)',
        black: '#171717',
        red: '#EF4444',
        green: '#4ADE80',
        yellow: '#FBBF24',
        blue: '#3B82F6',
        magenta: '#A855F7',
        cyan: '#22D3EE',
        white: '#E5E5E5',
        brightBlack: '#525252',
        brightRed: '#F87171',
        brightGreen: '#86EFAC',
        brightYellow: '#FDE047',
        brightBlue: '#60A5FA',
        brightMagenta: '#C084FC',
        brightCyan: '#67E8F9',
        brightWhite: '#FFFFFF',
      },
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      allowProposedApi: true,
      // Large scrollback so long Claude sessions stay fully scrollable, like
      // a regular CMD/PowerShell window. ~100 bytes/line ≈ 10MB per terminal
      // worst case, which is acceptable even with an 8-terminal grid.
      scrollback: 100000,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon((_event, uri) => {
      invoke('open_external_url', { url: uri }).catch((err) => {
        console.error('Failed to open URL:', err);
      });
    });
    const searchAddon = new SearchAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.loadAddon(searchAddon);
    searchAddonRef.current = searchAddon;

    terminal.open(containerRef.current);

    // Attach WebGL renderer for GPU-accelerated rendering. Gracefully fall
    // back to the default DOM renderer if the context is lost or unavailable
    // (older GPUs, headless CI, etc.).
    let webglAddon: WebglAddon | null = null;
    try {
      webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon?.dispose();
        webglAddon = null;
      });
      terminal.loadAddon(webglAddon);
    } catch (err) {
      console.warn('WebGL renderer unavailable, using DOM fallback:', err);
      webglAddon = null;
    }

    fitAddon.fit();

    // Auto-focus so keyboard input works immediately without requiring a click
    terminal.focus();

    // Re-focus xterm if its textarea loses focus to nothing (body) or to its
    // OWN canvas — that combo happens in WebView2 after PTY output triggers
    // React re-renders or when the user clicks the terminal canvas directly.
    // We must NOT refocus if focus moved to a sibling terminal's canvas (e.g.
    // the script-child pane), or to any input/textarea elsewhere — otherwise
    // the user can't type into the other terminal.
    const container = containerRef.current;
    const handleBlur = () => {
      requestAnimationFrame(() => {
        const focused = document.activeElement;
        if (!focused || focused === document.body) {
          terminal.focus();
          return;
        }
        if (focused.tagName === 'CANVAS' && container && container.contains(focused)) {
          terminal.focus();
        }
      });
    };
    terminal.textarea?.addEventListener('blur', handleBlur);

    // Handle Ctrl+C (copy) and Ctrl+V (paste) keyboard shortcuts
    terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      const isCtrl = e.ctrlKey || e.metaKey;

      // Ctrl+F: Toggle in-terminal search (Ctrl+Shift+F is reserved for the
      // global file/content search — see useKeyboardShortcuts).
      if (isCtrl && !e.shiftKey && e.key === 'f' && e.type === 'keydown') {
        e.preventDefault();
        toggleSearch();
        return false;
      }

      if (isCtrl && e.key === 'c' && e.type === 'keydown') {
        if (terminal.hasSelection()) {
          navigator.clipboard.writeText(terminal.getSelection());
          terminal.clearSelection();
          return false; // Prevent xterm from sending \x03
        }
        // No selection — let xterm send interrupt signal (Ctrl+C)
        return true;
      }

      // Ctrl+V: Let browser handle paste natively — fires paste event
      // on xterm's internal textarea, which xterm processes via onData.
      // This is more reliable than the async Clipboard API which can fail
      // silently due to focus/permission issues.
      if (isCtrl && e.key === 'v') {
        return false;
      }

      // Ctrl+Z: Send suspend/EOF signal to terminal (prevent browser undo)
      if (isCtrl && !e.shiftKey && e.key === 'z') {
        if (e.type === 'keydown') {
          e.preventDefault();
          writeToTerminal(terminalId, '\x1a');
        }
        return false;
      }

      return true;
    });

    // Track time of the last input event so we can identify chunks that arrive
    // as a single block (clipboard paste) vs. interactive typing.
    let lastDataTs = 0;
    let bypassDetectOnce = false;

    terminal.onData((data) => {
      const now = performance.now();
      const isLikelyPaste = data.length > 64 && (now - lastDataTs > 16 || lastDataTs === 0);
      lastDataTs = now;

      if (bypassDetectOnce) {
        bypassDetectOnce = false;
        writeToTerminal(terminalId, data).catch((err) => {
          console.error(`Failed to write to terminal ${terminalId}:`, err);
        });
        return;
      }

      // Pull the latest settings each call — these change in Settings without
      // re-rendering this terminal.
      const app = useAppStore.getState();
      if (!isLikelyPaste || !app.pasteAutoDetectEnabled) {
        writeToTerminal(terminalId, data).catch((err) => {
          console.error(`Failed to write to terminal ${terminalId}:`, err);
        });
        return;
      }

      const bytes = new TextEncoder().encode(data).length;
      const lines = data.split('\n').length;
      if (bytes < app.pasteAutoDetectThresholdBytes && lines < app.pasteAutoDetectThresholdLines) {
        writeToTerminal(terminalId, data).catch((err) => {
          console.error(`Failed to write to terminal ${terminalId}:`, err);
        });
        return;
      }

      // Suppress forwarding to PTY; offer the choice via a toast with actions.
      toast.info(
        'Large paste detected',
        `${(bytes / 1024).toFixed(1)} KB · ${lines} lines`,
        {
          duration: 8000,
          actions: [
            {
              label: 'Save & Reference',
              primary: true,
              onClick: () => {
                useAppStore.getState().openPasteDrawer({
                  content: data,
                  targetTerminalId: terminalId,
                });
              },
            },
            {
              label: 'Paste anyway',
              onClick: () => {
                bypassDetectOnce = true;
                writeToTerminal(terminalId, data).catch((err) => {
                  console.error(`Failed to write to terminal ${terminalId}:`, err);
                });
              },
            },
            {
              label: "Don't ask again",
              onClick: () => {
                useAppStore.getState().setPasteAutoDetectEnabled(false);
                writeToTerminal(terminalId, data).catch((err) => {
                  console.error(`Failed to write to terminal ${terminalId}:`, err);
                });
              },
            },
          ],
        },
      );
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      resizeTerminal(terminalId, terminal.cols, terminal.rows);
    });
    resizeObserver.observe(containerRef.current);

    terminalRef.current = terminal;
    setXterm(terminalId, terminal);

    return () => {
      resizeObserver.disconnect();
      terminal.textarea?.removeEventListener('blur', handleBlur);
      searchAddonRef.current = null;
      terminalRef.current = null;
      webglAddon?.dispose();
      terminal.dispose();
    };
    // Intentionally omit store action refs from deps — they are stable via
    // getState() and including them caused the xterm instance to be recreated
    // on every unrelated store update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId, !!instance, toggleSearch]);

  // OS → terminal file drag-drop. Tauri intercepts drag events at the window
  // level and delivers physical-pixel positions, so we hit-test against this
  // terminal's bounding rect to route drops in grid mode.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    const hitTest = (physX: number, physY: number): boolean => {
      const el = containerRef.current;
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      const x = physX / scale;
      const y = physY / scale;
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    };

    getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === 'leave') {
          setIsDragOver(false);
          return;
        }
        const inside = hitTest(payload.position.x, payload.position.y);
        if (payload.type === 'enter' || payload.type === 'over') {
          setIsDragOver(inside);
          return;
        }
        if (payload.type === 'drop') {
          setIsDragOver(false);
          if (!inside) return;
          const paths = payload.paths ?? [];
          if (paths.length === 0) return;
          const text = paths.map(formatDroppedPath).join(' ') + ' ';
          useTerminalStore.getState().writeToTerminal(terminalId, text).catch((err) => {
            console.error(`Failed to write dropped paths to terminal ${terminalId}:`, err);
          });
          terminalRef.current?.focus();
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((err) => {
        console.warn('Failed to register drag-drop listener:', err);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [terminalId]);

  return (
    <div className="h-full w-full bg-bg-primary relative flex flex-col">
      <TerminalSearch
        searchAddon={searchAddonRef.current}
        visible={searchVisible}
        onClose={() => setSearchVisible(false)}
      />
      <div
        ref={containerRef}
        className="flex-1 min-h-0 w-full relative"
        onMouseDown={() => terminalRef.current?.focus()}
      >
        {isDragOver && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-accent-primary/10 ring-2 ring-accent-primary/60 ring-inset">
            <div className="bg-bg-primary/90 text-text-primary text-[13px] px-3 py-1.5 rounded-md ring-1 ring-accent-primary/40">
              Drop file to paste path
            </div>
          </div>
        )}
      </div>
      <TerminalStatusBar terminalId={terminalId} />
    </div>
  );
}
