import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { useAppStore } from '../store/appStore';
import { resolveTerminalTheme } from '../lib/terminalThemes';
import '@xterm/xterm/css/xterm.css';

// Sample content shown in the preview. The arrows on the last line make the
// BiDi toggle visible - Unicode11 + RTL rendering reorders them.
const SAMPLE_LINES = [
  '\x1b[38;5;39m$\x1b[0m npm run dev',
  '\x1b[38;5;46m[INFO]\x1b[0m vite ready in 921 ms',
  '\x1b[38;5;196m[ERROR]\x1b[0m sample error highlight',
  'The quick brown fox 1234567890 → ←',
];

export function TerminalAppearancePreview() {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  const fontFamily = useAppStore((s) => s.terminalFontFamily);
  const fontSize = useAppStore((s) => s.terminalFontSize);
  const lineHeight = useAppStore((s) => s.terminalLineHeight);
  const cursorStyle = useAppStore((s) => s.terminalCursorStyle);
  const cursorBlink = useAppStore((s) => s.terminalCursorBlink);
  const themeName = useAppStore((s) => s.terminalTheme);
  const bidi = useAppStore((s) => s.terminalBidi);
  // Re-resolve 'auto' when the app appearance flips while Settings is open.
  const themeMode = useAppStore((s) => s.themeMode);
  const effectiveAppTheme: 'dark' | 'light' = themeMode === 'auto'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : themeMode;

  // Construct once; live-apply settings via the second effect. Recreate only
  // on bidi change (Unicode11 addon attaches once at construction).
  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      fontFamily,
      fontSize,
      lineHeight,
      cursorStyle,
      cursorBlink,
      cursorWidth: 2,
      theme: resolveTerminalTheme(themeName),
      allowProposedApi: true,
      scrollback: 0,
      disableStdin: true,
      convertEol: true,
    });

    const fit = new FitAddon();
    terminal.loadAddon(fit);

    if (bidi) {
      try {
        terminal.loadAddon(new Unicode11Addon());
        terminal.unicode.activeVersion = '11';
      } catch (err) {
        console.warn('BiDi (Unicode11) addon failed to load in preview:', err);
      }
    }

    terminal.open(containerRef.current);
    fit.fit();
    SAMPLE_LINES.forEach((line) => terminal.writeln(line));

    terminalRef.current = terminal;
    fitRef.current = fit;

    return () => {
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
    // Recreate only on bidi flip - everything else is live-applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bidi]);

  // Live-apply font / size / line-height / cursor / theme to the existing
  // instance. fit() after font/size/line-height because cell metrics change.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontFamily = fontFamily;
    terminal.options.fontSize = fontSize;
    terminal.options.lineHeight = lineHeight;
    terminal.options.cursorStyle = cursorStyle;
    terminal.options.cursorBlink = cursorBlink;
    terminal.options.theme = resolveTerminalTheme(themeName, undefined, effectiveAppTheme);
    fitRef.current?.fit();
  }, [fontFamily, fontSize, lineHeight, cursorStyle, cursorBlink, themeName, effectiveAppTheme]);

  return (
    <div className="rounded-md ring-1 ring-border-light overflow-hidden bg-bg-elevated">
      <div ref={containerRef} className="h-[120px] w-full p-2" />
    </div>
  );
}
