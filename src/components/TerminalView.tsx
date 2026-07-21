import { useEffect, useRef, useState, useCallback } from 'react';
import { Copy, ClipboardPaste } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useTerminalStore } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import { toast } from '../store/toastStore';
import { resolveTerminalTheme } from '../lib/terminalThemes';
import { copyText, readClipboardText } from '../lib/clipboard';
import { isVisibilityHidden } from '../utils/dragDrop';
import { TerminalSearch } from './TerminalSearch';
import { TerminalStatusBar } from './TerminalStatusBar';
import '@xterm/xterm/css/xterm.css';

function formatDroppedPath(path: string): string {
  // Strip control characters - macOS/Linux filenames can legally contain
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
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [searchVisible, setSearchVisible] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  // Right-click context menu (copy / paste). null when closed; otherwise the
  // viewport coordinates to anchor the menu at and whether a selection exists.
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null);
  // The right-click itself collapses the terminal selection (focus + textarea
  // reposition happen before the `contextmenu` event fires), so by the time the
  // menu reads hasSelection() it's already gone. We snapshot the selection text
  // in the CAPTURE phase of mousedown - before any handler can clear it - and
  // the menu's Copy uses this snapshot instead of a (now-empty) live read.
  const menuSelectionRef = useRef<string>('');
  // Narrow selector - only re-render when THIS terminal's instance changes,
  // not on every output-unread-set update for other terminals.
  const instance = useTerminalStore((s) => s.terminals.get(terminalId));
  // Stable action refs: these are static on the store so pulling them via
  // getState avoids putting them in the effect dep array (which was causing
  // the xterm instance to tear down on every unrelated store update).
  const writeToTerminal = useTerminalStore.getState().writeToTerminal;
  const resizeTerminal = useTerminalStore.getState().resizeTerminal;
  const setXterm = useTerminalStore.getState().setXterm;

  // Terminal appearance settings (issue #21). Scrollback and BiDi need a
  // recreate when they change (xterm caches buffer at construction; the
  // Unicode11 addon attaches once), so they're part of the construction effect's
  // dep list. The other six are live-applied in the second effect below.
  const fontFamily = useAppStore((s) => s.terminalFontFamily);
  const fontSize = useAppStore((s) => s.terminalFontSize);
  const lineHeight = useAppStore((s) => s.terminalLineHeight);
  const cursorStyle = useAppStore((s) => s.terminalCursorStyle);
  const cursorBlink = useAppStore((s) => s.terminalCursorBlink);
  const scrollback = useAppStore((s) => s.terminalScrollback);
  const themeName = useAppStore((s) => s.terminalTheme);
  const accentColorHex = useAppStore((s) => s.accentColorHex);
  const bidi = useAppStore((s) => s.terminalBidi);
  const scrollbarMode = useAppStore((s) => s.terminalScrollbarMode);

  const toggleSearch = useCallback(() => {
    setSearchVisible(prev => !prev);
  }, []);

  // Snapshot the selection in the capture phase, before the right-click can
  // collapse it. Falls back to a live read for keyboard-invoked menus (Menu
  // key), which fire `contextmenu` with no preceding mousedown.
  const captureSelectionForMenu = useCallback((e: React.MouseEvent) => {
    if (e.button !== 2) return;
    menuSelectionRef.current = terminalRef.current?.getSelection() ?? '';
  }, []);

  const openContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const snapshot = menuSelectionRef.current || terminalRef.current?.getSelection() || '';
    menuSelectionRef.current = snapshot;
    setContextMenu({ x: e.clientX, y: e.clientY, hasSelection: snapshot.length > 0 });
  }, []);

  const handleMenuCopy = useCallback(() => {
    const text = menuSelectionRef.current;
    if (text) copyText(text);
    setContextMenu(null);
  }, []);

  const handleMenuPaste = useCallback(async () => {
    setContextMenu(null);
    try {
      const text = await readClipboardText();
      if (text) await writeToTerminal(terminalId, text);
      terminalRef.current?.focus();
    } catch {
      toast.error('Paste failed', 'Could not read the clipboard.');
    }
  }, [terminalId, writeToTerminal]);

  // Close the context menu on any outside mousedown or Escape.
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setContextMenu(null); };
    // Bubble-phase mousedown; the menu stops propagation on its own mousedown
    // so clicking a menu item doesn't dismiss before its onClick fires.
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!containerRef.current || !instance) return;

    // Initial options come from the appStore (issue #21). The first effect
    // owns construction; the second effect below live-applies the six options
    // that don't require a recreate (font, size, line-height, cursor, theme).
    // Scrollback and BiDi DO require a recreate, so they appear in this
    // effect's deps.
    const terminal = new Terminal({
      theme: resolveTerminalTheme(
        useAppStore.getState().terminalTheme,
        useAppStore.getState().accentColorHex,
      ),
      fontFamily: useAppStore.getState().terminalFontFamily,
      fontSize: useAppStore.getState().terminalFontSize,
      lineHeight: useAppStore.getState().terminalLineHeight,
      cursorBlink: useAppStore.getState().terminalCursorBlink,
      cursorStyle: useAppStore.getState().terminalCursorStyle,
      cursorWidth: 2,
      allowProposedApi: true,
      scrollback,
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
    fitAddonRef.current = fitAddon;

    // BiDi (issue #21): opt-in Unicode11 addon enables grapheme-aware width
    // calculation and the proposed BiDi rendering path in xterm. Off by
    // default, attached only when the user enables the toggle.
    if (bidi) {
      try {
        terminal.loadAddon(new Unicode11Addon());
        terminal.unicode.activeVersion = '11';
      } catch (err) {
        console.warn('BiDi (Unicode11) addon failed to load:', err);
      }
    }

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
    // OWN canvas - that combo happens in WebView2 after PTY output triggers
    // React re-renders or when the user clicks the terminal canvas directly.
    // We must NOT refocus if focus moved to a sibling terminal's canvas (e.g.
    // the script-child pane), or to any input/textarea elsewhere - otherwise
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

    // Copy-on-select: when the user finishes a mouse drag selection and the
    // "Copy on select" setting is on, copy it to the clipboard. We fire on
    // mouseup (drag complete) rather than onSelectionChange so the hidden-
    // textarea fallback in copyText() can't steal focus mid-drag. The setting
    // is read live via getState() so toggling it takes effect without a
    // recreate. Selection is intentionally left intact so the user sees what
    // was copied.
    const handleMouseUp = () => {
      if (useAppStore.getState().terminalCopyOnSelect && terminal.hasSelection()) {
        copyText(terminal.getSelection());
      }
    };
    container.addEventListener('mouseup', handleMouseUp);

    // Handle Ctrl+C (copy) and Ctrl+V (paste) keyboard shortcuts
    terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      const isCtrl = e.ctrlKey || e.metaKey;
      // Normalize the key so CapsLock doesn't break these shortcuts: with
      // CapsLock on, an unshifted letter arrives as uppercase (e.g. 'V'), which
      // would otherwise miss the lowercase comparisons below and fall through to
      // xterm's raw control byte (no paste/copy). Shift is still distinguished
      // via e.shiftKey, so Ctrl+Shift+V stays handled by the global handler.
      const key = e.key.toLowerCase();

      // Ctrl+F: Toggle in-terminal search (Ctrl+Shift+F is reserved for the
      // global file/content search - see useKeyboardShortcuts).
      if (isCtrl && !e.shiftKey && key === 'f' && e.type === 'keydown') {
        e.preventDefault();
        toggleSearch();
        return false;
      }

      if (isCtrl && !e.shiftKey && key === 'c' && e.type === 'keydown') {
        if (terminal.hasSelection()) {
          // copyText() falls back to execCommand when navigator.clipboard
          // rejects with "Document is not focused" - which happens in this
          // WebView2 window right after a canvas drag-select.
          copyText(terminal.getSelection());
          terminal.clearSelection();
          return false; // Prevent xterm from sending \x03
        }
        // No selection - let xterm send interrupt signal (Ctrl+C)
        return true;
      }

      // Ctrl+V (no Shift): behavior depends on the "Paste shortcut" setting.
      //  - 'ctrl+v'       → let the browser paste natively (fires a paste event
      //                     on xterm's textarea, processed via onData). More
      //                     reliable than the async Clipboard API.
      //  - 'ctrl+shift+v' → plain Ctrl+V should NOT paste; forward the raw
      //                     Ctrl+V control byte (0x16) to the program. Pasting
      //                     is then done via right-click or Ctrl+Shift+V
      //                     ("Paste as file"), which is unaffected here.
      // Ctrl+Shift+V (e.key === 'V') is intentionally not matched - it's
      // handled by the global shortcut handler.
      if (isCtrl && !e.shiftKey && key === 'v') {
        if (useAppStore.getState().terminalPasteShortcut === 'ctrl+v') {
          return false;
        }
        if (e.type === 'keydown') {
          e.preventDefault();
          writeToTerminal(terminalId, '\x16');
        }
        return false;
      }

      // Ctrl+Z: map the familiar desktop "undo" gesture onto Claude Code's
      // actual undo binding. Claude Code binds undo to Ctrl+_ (byte 0x1f), NOT
      // Ctrl+Z - a raw 0x1a is SIGTSTP/suspend and does nothing useful in the
      // prompt. So we send 0x1f. (Also prevents any browser-level undo.)
      if (isCtrl && !e.shiftKey && key === 'z') {
        if (e.type === 'keydown') {
          e.preventDefault();
          writeToTerminal(terminalId, '\x1f');
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

      // Pull the latest settings each call - these change in Settings without
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
      // `warning` (amber) reads as "attention needed" - louder than info blue,
      // which the user said felt easy to miss.
      toast.warning(
        'Large paste detected',
        `${(bytes / 1024).toFixed(1)} KB · ${lines} lines - pasting this directly into Claude Code can hang the terminal. Save it as a file and reference it instead?`,
        {
          duration: 15000,
          actions: [
            {
              label: 'Save & Reference',
              variant: 'primary',
              onClick: () => {
                useAppStore.getState().openPasteDrawer({
                  content: data,
                  targetTerminalId: terminalId,
                });
              },
            },
            {
              label: 'Paste anyway',
              variant: 'neutral',
              onClick: () => {
                bypassDetectOnce = true;
                writeToTerminal(terminalId, data).catch((err) => {
                  console.error(`Failed to write to terminal ${terminalId}:`, err);
                });
              },
            },
            {
              label: "Don't ask again",
              variant: 'danger',
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
      container.removeEventListener('mouseup', handleMouseUp);
      searchAddonRef.current = null;
      fitAddonRef.current = null;
      terminalRef.current = null;
      webglAddon?.dispose();
      terminal.dispose();
    };
    // Intentionally omit store action refs from deps - they are stable via
    // getState() and including them caused the xterm instance to be recreated
    // on every unrelated store update. `scrollback` and `bidi` ARE in the dep
    // list because xterm caches the buffer at construction and the Unicode11
    // addon attaches once - flipping either has to recreate the instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId, !!instance, toggleSearch, scrollback, bidi]);

  // Live-apply the six options that don't require recreate (issue #21).
  // After font/size/line-height change, xterm cell metrics shift, so we
  // re-fit and push the new size to the PTY so it knows about the new
  // cols/rows. Cursor + theme are pure visual changes - no resize needed.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontFamily = fontFamily;
    terminal.options.fontSize = fontSize;
    terminal.options.lineHeight = lineHeight;
    terminal.options.cursorStyle = cursorStyle;
    terminal.options.cursorBlink = cursorBlink;
    terminal.options.theme = resolveTerminalTheme(themeName, accentColorHex);
    // Refit + push new dimensions to the PTY whenever cell metrics may have
    // changed. fit() is a no-op if cols/rows didn't actually shift.
    fitAddonRef.current?.fit();
    resizeTerminal(terminalId, terminal.cols, terminal.rows);
  }, [fontFamily, fontSize, lineHeight, cursorStyle, cursorBlink, themeName, accentColorHex, terminalId, resizeTerminal]);

  // Scrollbar visibility. The native xterm scrollbar (`.xterm-viewport`) is
  // transparent by default (see index.css); a class drives whether it shows.
  //  - 'hidden'    → `ct-sb-hidden` collapses the gutter.
  //  - 'always'    → `ct-sb-show` stays on (CSS still draws no thumb if the
  //                  buffer isn't scrollable).
  //  - 'auto-hide' → reveal on mouse move / scroll, but only when there's
  //                  something to scroll, then fade out ~1.5s after the last
  //                  interaction. PTY output alone never reveals it.
  // scrollback/bidi are in the deps because they recreate the xterm instance
  // (and thus the .xterm-viewport element), so we must re-grab and re-wire it.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
    if (!viewport) return;

    viewport.classList.remove('ct-sb-show', 'ct-sb-hidden');

    if (scrollbarMode === 'hidden') {
      viewport.classList.add('ct-sb-hidden');
      return;
    }
    if (scrollbarMode === 'always') {
      viewport.classList.add('ct-sb-show');
      return;
    }

    // auto-hide
    let hideTimer: number | undefined;
    const isScrollable = () => viewport.scrollHeight - viewport.clientHeight > 2;
    const reveal = () => {
      if (!isScrollable()) return;
      viewport.classList.add('ct-sb-show');
      if (hideTimer) window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => viewport.classList.remove('ct-sb-show'), 1500);
    };
    container.addEventListener('mousemove', reveal);
    viewport.addEventListener('scroll', reveal);

    return () => {
      if (hideTimer) window.clearTimeout(hideTimer);
      container.removeEventListener('mousemove', reveal);
      viewport.removeEventListener('scroll', reveal);
      viewport.classList.remove('ct-sb-show');
    };
  }, [scrollbarMode, terminalId, scrollback, bidi]);

  // OS → terminal file drag-drop. Tauri intercepts drag events at the window
  // level and delivers physical-pixel positions, so we hit-test against this
  // terminal's bounding rect to route drops in grid mode.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    const hitTest = (physX: number, physY: number): boolean => {
      const el = containerRef.current;
      if (!el) return false;
      // Inactive tab terminals are visibility: hidden but keep their layout
      // box, so their rects still cover the drop point — without this check a
      // drop pastes the path into every mounted terminal.
      if (isVisibilityHidden(el)) return false;
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
        onMouseDownCapture={captureSelectionForMenu}
        onMouseDown={(e) => { if (e.button !== 2) terminalRef.current?.focus(); }}
        onContextMenu={openContextMenu}
      >
        {isDragOver && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-accent-primary/10 ring-2 ring-accent-primary/60 ring-inset">
            <div className="bg-bg-primary/90 text-text-primary text-[13px] px-3 py-1.5 rounded-md ring-1 ring-accent-primary/40">
              Drop file to paste path
            </div>
          </div>
        )}
      </div>
      {contextMenu && (
        <div
          role="menu"
          data-context-menu="terminal"
          className="fixed z-[80] min-w-[160px] bg-bg-elevated ring-1 ring-white/[0.08] rounded-md py-1 select-none"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            disabled={!contextMenu.hasSelection}
            onClick={handleMenuCopy}
            className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-[12px] transition-colors ${
              contextMenu.hasSelection
                ? 'text-text-primary hover:bg-white/[0.06]'
                : 'text-text-tertiary/50 cursor-not-allowed'
            }`}
          >
            <span className={contextMenu.hasSelection ? 'text-text-tertiary' : 'opacity-50'}>
              <Copy size={13} strokeWidth={1.75} />
            </span>
            <span className="flex-1">Copy</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={handleMenuPaste}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-[12px] text-text-primary hover:bg-white/[0.06] transition-colors"
          >
            <span className="text-text-tertiary">
              <ClipboardPaste size={13} strokeWidth={1.75} />
            </span>
            <span className="flex-1">Paste</span>
          </button>
        </div>
      )}
      <TerminalStatusBar terminalId={terminalId} />
    </div>
  );
}
