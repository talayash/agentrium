import { useAppStore } from '../../../store/appStore';
import { PageHeader, PageSection, SettingRow, Toggle } from '../SettingRow';
import { registerSetting } from '../index';

const cat = { group: 'appearance-behavior', page: 'startup-session' } as const;
registerSetting({ category: cat, id: 'restore-session', label: 'Restore previous session', keywords: ['startup', 'restore'] });
registerSetting({ category: cat, id: 'auto-save',       label: 'Auto-save interval',      keywords: ['session', 'interval'] });
registerSetting({ category: cat, id: 'confirm-close',   label: 'Confirm on app close',    keywords: ['quit', 'exit'] });

export default function StartupSessionPage() {
  const restoreSession = useAppStore((s) => s.restoreSession);
  const sessionAutoSaveIntervalSec = useAppStore((s) => s.sessionAutoSaveIntervalSec);
  const confirmOnAppClose = useAppStore((s) => s.confirmOnAppClose);
  const { setRestoreSession, setSessionAutoSaveIntervalSec, setConfirmOnAppClose } = useAppStore.getState();

  return (
    <div>
      <PageHeader title="Startup & Session" />

      <PageSection title="Session">
        <SettingRow label="Restore previous session" description="Reopen terminals from last session on startup.">
          <Toggle value={restoreSession} onChange={setRestoreSession} />
        </SettingRow>
        <SettingRow
          label="Auto-save interval (seconds)"
          description={`Currently ${sessionAutoSaveIntervalSec}s. Restart required for changes to take effect.`}
        >
          <input
            type="number"
            min={10}
            max={600}
            value={sessionAutoSaveIntervalSec}
            onChange={(e) => setSessionAutoSaveIntervalSec(parseInt(e.target.value, 10) || 30)}
            className="w-24 bg-elevation-0 text-text-primary text-right text-[12px] px-2 py-1 rounded ring-1 ring-border-light"
          />
        </SettingRow>
        <SettingRow label="Confirm before closing app" description="Ask for confirmation when quitting with running terminals.">
          <Toggle value={confirmOnAppClose} onChange={setConfirmOnAppClose} />
        </SettingRow>
      </PageSection>
    </div>
  );
}
