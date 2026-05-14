import { useAppStore } from '../../../store/appStore';
import { PageHeader, PageSection, SettingRow, Toggle, Segmented } from '../SettingRow';
import { registerSetting } from '../index';

const cat = { group: 'terminal', page: 'behavior' } as const;
['shell-override', 'copy-on-select', 'paste-shortcut'].forEach((id) =>
  registerSetting({ category: cat, id, label: id.replace(/-/g, ' '), keywords: ['terminal', 'shell', id] })
);

export default function TerminalBehaviorPage() {
  const terminalShellPathOverride = useAppStore((s) => s.terminalShellPathOverride);
  const terminalCopyOnSelect = useAppStore((s) => s.terminalCopyOnSelect);
  const terminalPasteShortcut = useAppStore((s) => s.terminalPasteShortcut);
  const { setTerminalShellPathOverride, setTerminalCopyOnSelect, setTerminalPasteShortcut } = useAppStore.getState();

  return (
    <div>
      <PageHeader title="Terminal — Behavior" />

      <PageSection title="Shell">
        <SettingRow
          label="Shell path override"
          description="Used by plain-shell terminals. Leave empty for platform default (PowerShell on Windows, $SHELL elsewhere)."
        >
          <input
            type="text"
            placeholder="e.g. C:\Windows\System32\cmd.exe"
            value={terminalShellPathOverride}
            onChange={(e) => setTerminalShellPathOverride(e.target.value)}
            className="w-72 bg-elevation-0 text-text-primary text-[12px] px-2 py-1 rounded ring-1 ring-border-light font-mono"
          />
        </SettingRow>
      </PageSection>

      <PageSection title="Selection">
        <SettingRow label="Copy on select" description="Automatically copy selected text to the clipboard.">
          <Toggle value={terminalCopyOnSelect} onChange={setTerminalCopyOnSelect} />
        </SettingRow>
        <SettingRow label="Paste shortcut">
          <Segmented
            value={terminalPasteShortcut}
            onChange={setTerminalPasteShortcut}
            options={[
              { value: 'ctrl+shift+v', label: 'Ctrl+Shift+V' },
              { value: 'ctrl+v',       label: 'Ctrl+V' },
            ]}
          />
        </SettingRow>
      </PageSection>
    </div>
  );
}
