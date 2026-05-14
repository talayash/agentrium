import { useAppStore } from '../../../store/appStore';
import { PageHeader, PageSection, SettingRow, Toggle } from '../SettingRow';
import { registerSetting } from '../index';

const cat = { group: 'terminal', page: 'pastes' } as const;
['auto-detect', 'thresholds', 'template', 'retention'].forEach((id) =>
  registerSetting({ category: cat, id, label: id, keywords: ['paste', 'clipboard', id] })
);

export default function TerminalPastesPage() {
  const pasteAutoDetectEnabled = useAppStore((s) => s.pasteAutoDetectEnabled);
  const pasteAutoDetectThresholdBytes = useAppStore((s) => s.pasteAutoDetectThresholdBytes);
  const pasteAutoDetectThresholdLines = useAppStore((s) => s.pasteAutoDetectThresholdLines);
  const pastePromptTemplate = useAppStore((s) => s.pastePromptTemplate);
  const pasteRetention = useAppStore((s) => s.pasteRetention);
  const pasteRetentionDays = useAppStore((s) => s.pasteRetentionDays);
  const {
    setPasteAutoDetectEnabled, setPasteAutoDetectThresholdBytes, setPasteAutoDetectThresholdLines,
    setPastePromptTemplate, setPasteRetention, setPasteRetentionDays,
  } = useAppStore.getState();

  return (
    <div>
      <PageHeader
        title="Terminal — Pastes"
        description="Capture large pastes into files under .claudeterminal/pastes/ for use as @mentions."
      />

      <PageSection title="Auto-detect">
        <SettingRow label="Auto-detect large pastes">
          <Toggle value={pasteAutoDetectEnabled} onChange={setPasteAutoDetectEnabled} />
        </SettingRow>
        <SettingRow label="Threshold (bytes)">
          <input
            type="number" min={256} value={pasteAutoDetectThresholdBytes}
            onChange={(e) => setPasteAutoDetectThresholdBytes(parseInt(e.target.value, 10) || 4096)}
            className="w-24 bg-elevation-0 text-text-primary text-right text-[12px] px-2 py-1 rounded ring-1 ring-border-light"
          />
        </SettingRow>
        <SettingRow label="Threshold (lines)">
          <input
            type="number" min={5} value={pasteAutoDetectThresholdLines}
            onChange={(e) => setPasteAutoDetectThresholdLines(parseInt(e.target.value, 10) || 50)}
            className="w-24 bg-elevation-0 text-text-primary text-right text-[12px] px-2 py-1 rounded ring-1 ring-border-light"
          />
        </SettingRow>
      </PageSection>

      <PageSection title="Prompt">
        <SettingRow label="Prompt template" description="Use {path} as placeholder.">
          <input
            type="text" value={pastePromptTemplate}
            onChange={(e) => setPastePromptTemplate(e.target.value)}
            className="w-72 bg-elevation-0 text-text-primary text-[12px] px-2 py-1 rounded ring-1 ring-border-light font-mono"
          />
        </SettingRow>
      </PageSection>

      <PageSection title="Retention">
        <SettingRow label="Retention policy">
          <select
            value={pasteRetention}
            onChange={(e) => setPasteRetention(e.target.value as 'close' | 'days' | 'forever')}
            className="bg-elevation-0 text-text-primary text-[12px] px-2 py-1 rounded ring-1 ring-border-light"
          >
            <option value="close">Delete on terminal close</option>
            <option value="days">Keep for N days</option>
            <option value="forever">Keep forever</option>
          </select>
        </SettingRow>
        {pasteRetention === 'days' && (
          <SettingRow label="Days to keep">
            <input
              type="number" min={1} value={pasteRetentionDays}
              onChange={(e) => setPasteRetentionDays(parseInt(e.target.value, 10) || 7)}
              className="w-24 bg-elevation-0 text-text-primary text-right text-[12px] px-2 py-1 rounded ring-1 ring-border-light"
            />
          </SettingRow>
        )}
      </PageSection>
    </div>
  );
}
