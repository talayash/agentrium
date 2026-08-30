import {
  useAppStore, TERMINAL_SCROLLBACK_PRESETS, DEFAULT_TERMINAL_FONT_FAMILY,
} from '../../../store/appStore';
import { Minus, Plus } from 'lucide-react';
import { PageHeader, PageSection, SettingRow, Toggle, Segmented } from '../SettingRow';
import { TerminalAppearancePreview } from '../../TerminalAppearancePreview';
import { registerSetting } from '../index';

const cat = { group: 'terminal', page: 'appearance' } as const;
['font-family', 'font-size', 'line-height', 'cursor-style', 'cursor-blink', 'scrollback', 'theme', 'bidi', 'scrollbar'].forEach(
  (id) => registerSetting({ category: cat, id, label: id.replace(/-/g, ' '), keywords: ['xterm', 'terminal', id] })
);

const FONT_OPTIONS = [
  { label: 'Auto (recommended)', value: DEFAULT_TERMINAL_FONT_FAMILY },
  { label: 'JetBrains Mono',     value: '"JetBrains Mono", monospace' },
  { label: 'Cascadia Code',      value: '"Cascadia Code", monospace' },
  { label: 'Consolas',           value: 'Consolas, monospace' },
  { label: 'Fira Code',          value: '"Fira Code", monospace' },
];

export default function TerminalAppearancePage() {
  const terminalFontFamily = useAppStore((s) => s.terminalFontFamily);
  const terminalFontSize = useAppStore((s) => s.terminalFontSize);
  const terminalLineHeight = useAppStore((s) => s.terminalLineHeight);
  const terminalCursorStyle = useAppStore((s) => s.terminalCursorStyle);
  const terminalCursorBlink = useAppStore((s) => s.terminalCursorBlink);
  const terminalScrollback = useAppStore((s) => s.terminalScrollback);
  const terminalTheme = useAppStore((s) => s.terminalTheme);
  const terminalBidi = useAppStore((s) => s.terminalBidi);
  const terminalScrollbarMode = useAppStore((s) => s.terminalScrollbarMode);
  const {
    setTerminalFontFamily, setTerminalFontSize, setTerminalLineHeight,
    setTerminalCursorStyle, setTerminalCursorBlink, setTerminalScrollback,
    setTerminalTheme, setTerminalBidi, setTerminalScrollbarMode,
  } = useAppStore.getState();

  return (
    <div>
      <PageHeader title="Terminal - Appearance" />
      <PageSection title="Preview">
        <div className="py-2"><TerminalAppearancePreview /></div>
      </PageSection>

      <PageSection title="Font">
        <SettingRow label="Family">
          <select
            value={FONT_OPTIONS.some((o) => o.value === terminalFontFamily) ? terminalFontFamily : DEFAULT_TERMINAL_FONT_FAMILY}
            onChange={(e) => setTerminalFontFamily(e.target.value)}
            className="bg-elevation-0 text-text-primary text-[12px] px-2 py-1 rounded ring-1 ring-border-light"
          >
            {FONT_OPTIONS.map((o) => <option key={o.label} value={o.value}>{o.label}</option>)}
          </select>
        </SettingRow>
        <SettingRow label="Size">
          <div className="flex items-center gap-1">
            <button onClick={() => setTerminalFontSize(terminalFontSize - 1)} className="w-7 h-7 flex items-center justify-center bg-elevation-0 ring-1 ring-border-light rounded text-text-secondary"><Minus size={12} /></button>
            <span className="w-10 text-center text-text-primary text-[12px] tabular-nums">{terminalFontSize}</span>
            <button onClick={() => setTerminalFontSize(terminalFontSize + 1)} className="w-7 h-7 flex items-center justify-center bg-elevation-0 ring-1 ring-border-light rounded text-text-secondary"><Plus size={12} /></button>
          </div>
        </SettingRow>
        <SettingRow label="Line height">
          <div className="flex items-center gap-1">
            <button onClick={() => setTerminalLineHeight(terminalLineHeight - 0.1)} className="w-7 h-7 flex items-center justify-center bg-elevation-0 ring-1 ring-border-light rounded text-text-secondary"><Minus size={12} /></button>
            <span className="w-10 text-center text-text-primary text-[12px] tabular-nums">{terminalLineHeight.toFixed(1)}</span>
            <button onClick={() => setTerminalLineHeight(terminalLineHeight + 0.1)} className="w-7 h-7 flex items-center justify-center bg-elevation-0 ring-1 ring-border-light rounded text-text-secondary"><Plus size={12} /></button>
          </div>
        </SettingRow>
      </PageSection>

      <PageSection title="Cursor">
        <SettingRow label="Style">
          <Segmented
            value={terminalCursorStyle}
            onChange={setTerminalCursorStyle}
            options={[
              { value: 'bar', label: 'Bar' },
              { value: 'block', label: 'Block' },
              { value: 'underline', label: 'Underline' },
            ]}
          />
        </SettingRow>
        <SettingRow label="Blink">
          <Toggle value={terminalCursorBlink} onChange={setTerminalCursorBlink} />
        </SettingRow>
      </PageSection>

      <PageSection title="Buffer & rendering">
        <SettingRow label="Scrollback (lines)" description="Per terminal. Lower values reduce memory in grid mode.">
          <Segmented
            value={String(terminalScrollback) as `${number}`}
            onChange={(v) => setTerminalScrollback(parseInt(v, 10))}
            options={TERMINAL_SCROLLBACK_PRESETS.map((n) => ({
              value: String(n) as `${number}`,
              label: n >= 1000 ? `${n / 1000}k` : String(n),
            }))}
          />
        </SettingRow>
        <SettingRow label="Theme" description="Auto follows the app's light/dark appearance.">
          <Segmented
            value={terminalTheme}
            onChange={setTerminalTheme}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' },
            ]}
          />
        </SettingRow>
        <SettingRow label="Scrollbar" description="Auto-hide reveals it on mouse move or scroll, then fades when idle.">
          <Segmented
            value={terminalScrollbarMode}
            onChange={setTerminalScrollbarMode}
            options={[
              { value: 'auto-hide', label: 'Auto-hide' },
              { value: 'always', label: 'Always' },
              { value: 'hidden', label: 'Hidden' },
            ]}
          />
        </SettingRow>
        <SettingRow label="BiDi rendering" description="RTL support (Hebrew/Arabic/Persian). Reattaches open terminals.">
          <Toggle value={terminalBidi} onChange={setTerminalBidi} />
        </SettingRow>
      </PageSection>
    </div>
  );
}
