import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../../../store/appStore';
import { PageHeader, PageSection, SettingRow, Toggle } from '../SettingRow';
import { registerSetting } from '../index';

const cat = { group: 'privacy-about', page: 'privacy' } as const;
['telemetry', 'error-reporting'].forEach((id) =>
  registerSetting({ category: cat, id, label: id.replace(/-/g, ' '), keywords: ['privacy', 'analytics', 'crash'] })
);

export default function PrivacyPage() {
  const telemetryEnabled = useAppStore((s) => s.telemetryEnabled);
  const errorReportingEnabled = useAppStore((s) => s.errorReportingEnabled);
  const { setTelemetryEnabled, setErrorReportingEnabled } = useAppStore.getState();

  return (
    <div>
      <PageHeader title="Privacy" />

      <PageSection title="Analytics">
        <SettingRow
          label="Anonymous usage analytics"
          description="Send anonymous app version and OS info to help improve ClaudeTerminal."
        >
          <Toggle value={telemetryEnabled} onChange={setTelemetryEnabled} />
        </SettingRow>
      </PageSection>

      <PageSection title="Error reporting">
        <SettingRow
          label="Send error reports"
          description="Helps fix crashes. Personal data is scrubbed before send."
        >
          <Toggle
            value={errorReportingEnabled}
            onChange={(next) => {
              setErrorReportingEnabled(next);
              invoke('set_error_reporting_enabled', { enabled: next }).catch(() => {});
            }}
          />
        </SettingRow>
      </PageSection>
    </div>
  );
}
