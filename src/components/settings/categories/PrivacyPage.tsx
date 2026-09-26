import { useEffect, useState } from 'react';
import { toast } from '../../../store/toastStore';
import { reportInvokeFailure } from '../../../lib/errorReporter';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../../../store/appStore';
import { PageHeader, PageSection, SettingRow, Toggle } from '../SettingRow';
import { registerSetting } from '../index';

const cat = { group: 'privacy-about', page: 'privacy' } as const;
['telemetry', 'error-reporting', 'external-summaries'].forEach((id) =>
  registerSetting({ category: cat, id, label: id.replace(/-/g, ' '), keywords: ['privacy', 'analytics', 'crash'] })
);

export default function PrivacyPage() {
  const [summaryEnabled, setSummaryEnabled] = useState(false);
  useEffect(() => {
    invoke<boolean>('get_summary_enabled').then(setSummaryEnabled).catch(() => {
      // Fail closed: the backend also checks consent on every request.
    });
  }, []);
  const telemetryEnabled = useAppStore((s) => s.telemetryEnabled);
  const errorReportingEnabled = useAppStore((s) => s.errorReportingEnabled);
  const { setTelemetryEnabled, setErrorReportingEnabled } = useAppStore.getState();

  return (
    <div>
      <PageHeader title="Privacy" />

      <PageSection title="Session summaries">
        <SettingRow label="External AI summaries" description="Off by default. When enabled, sends up to the last 16 KiB of terminal output to the model service configured in your Claude CLI. Known secrets are scrubbed, but source code and other sensitive text may remain. Leave off to keep session logs local.">
          <Toggle label="External AI summaries" value={summaryEnabled} onChange={(enabled) => {
            invoke('set_summary_enabled', { enabled }).then(() => setSummaryEnabled(enabled)).catch((err) => {
              toast.error('Could not change summary preference');
              reportInvokeFailure('set_summary_enabled', err);
            });
          }} />
        </SettingRow>
      </PageSection>
      <PageSection title="Cloud sync" description="Profiles and workspaces belong to the signed-in account. Switching accounts restores the saved data for that account. Environment values, command arguments, and credential bindings stay on this device; configure them locally on each computer. Cloud sync requires signing in with Google or GitHub to verify email ownership.">
        <p className="text-text-tertiary text-xs">Use the credential manager for API keys. Removing a local secret does not erase earlier cloud copies or backups.</p>
      </PageSection>
      <PageSection title="Analytics">
        <SettingRow
          label="Anonymous usage analytics"
          description="Send anonymous app version and OS info to help improve Agentrium."
        >
          <Toggle value={telemetryEnabled} onChange={setTelemetryEnabled} />
        </SettingRow>
      </PageSection>

      <PageSection title="Error reporting">
        <SettingRow
          label="Send error reports"
          description="Sends error messages and stack traces. Known secrets and home usernames are scrubbed, but other sensitive text may remain."
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
