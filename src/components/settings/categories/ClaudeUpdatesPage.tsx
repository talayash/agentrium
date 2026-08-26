import { useState, useEffect } from 'react';
import { Download, RefreshCw, AlertCircle, ExternalLink, Check, Rocket } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { useUpdaterStore } from '../../../store/updaterStore';
import { toast } from '../../../store/toastStore';
import { PageHeader, PageSection } from '../SettingRow';
import { Button } from '../../ui/Button';
import { registerSetting } from '../index';
import { AGENT_SPECS, type AgentKind, type AgentSpec } from '../../../lib/agents';
import { BrandIcon } from '../../BrandIcon';

registerSetting({
  category: { group: 'claude', page: 'updates' },
  id: 'app-and-cli-updates',
  label: 'App + agent CLI updates',
  keywords: ['update', 'upgrade', 'app', 'cli', 'version', 'agent', 'claude', 'codex', 'cursor', 'gemini'],
});

interface UpdateCheckResult {
  current_version: string;
  latest_version: string;
  update_available: boolean;
}

/**
 * Per-agent version card. Claude Code (the only agent with a proper
 * update-check backend right now) gets the full check + update UI. The
 * others show a version line, a Docs link, and - when not installed -
 * a one-line install hint. Update flows for Codex/Cursor/Gemini are a
 * follow-up (each has its own installer path, so unifying them is real
 * work).
 */
function AgentUpdateSection({ spec }: { spec: AgentSpec }) {
  const [version, setVersion] = useState<string>('');
  const [checking, setChecking] = useState(false);
  const [notInstalled, setNotInstalled] = useState(false);

  async function refresh() {
    setChecking(true);
    try {
      const v = await invoke<string>('get_agent_version', { agent: spec.kind });
      setVersion(v || '');
      setNotInstalled(!v);
    } catch {
      setVersion('');
      setNotInstalled(true);
    }
    setChecking(false);
  }

  useEffect(() => { refresh(); }, [spec.kind]);

  return (
    <PageSection
      title={
        <span className="flex items-center gap-2">
          <BrandIcon kind={spec.kind} size={14} />
          {spec.displayName}
        </span>
      }
    >
      <div className="flex items-center justify-between py-2 px-1">
        <div>
          <p className="text-text-primary text-[13px]">
            {checking ? 'Checking…' : notInstalled ? 'Not installed' : version}
          </p>
          {notInstalled && (
            <p className="text-text-tertiary text-[11px] mt-1 font-mono">{spec.installHint}</p>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            onClick={() => invoke('open_external_url', { url: spec.installUrl })}
            icon={<ExternalLink size={12} />}
          >
            Docs
          </Button>
          {notInstalled ? (
            <Button
              variant="secondary"
              onClick={refresh}
              disabled={checking}
              icon={<RefreshCw size={14} className={checking ? 'animate-spin' : ''} />}
            >
              Recheck
            </Button>
          ) : (
            <div className="flex items-center gap-2 bg-success/10 text-success h-9 px-4 rounded-md text-[12px] font-medium">
              <Check size={14} /> Detected
            </div>
          )}
        </div>
      </div>
    </PageSection>
  );
}

export default function ClaudeUpdatesPage() {
  const [claudeVersion, setClaudeVersion] = useState<string>('');
  const [latestVersion, setLatestVersion] = useState<string>('');
  const [updateAvailable, setUpdateAvailable] = useState<boolean | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [appVersion, setAppVersion] = useState<string>('');
  const appUpdater = useUpdaterStore();

  useEffect(() => {
    getVersion().then(setAppVersion);
    checkClaude();
    appUpdater.checkForUpdates();
  }, []);

  async function checkClaude() {
    setIsChecking(true);
    try {
      const result = await invoke<UpdateCheckResult>('check_claude_update');
      setClaudeVersion(result.current_version);
      setLatestVersion(result.latest_version);
      setUpdateAvailable(result.update_available);
    } catch {
      try {
        const v = await invoke<string>('get_claude_version');
        setClaudeVersion(v || 'Not installed');
      } catch {
        setClaudeVersion('Not installed');
      }
      setUpdateAvailable(null);
    }
    setIsChecking(false);
  }

  async function updateClaude() {
    if (updateAvailable === false) return;
    setIsUpdating(true);
    try {
      const result = await invoke<string>('update_claude_code');
      toast.success('Claude Updated', result);
      await checkClaude();
    } catch (e) {
      toast.error('Update Failed', String(e));
    }
    setIsUpdating(false);
  }

  const claudeSpec = AGENT_SPECS.find((s) => s.kind === 'claude')!;
  const otherAgents = AGENT_SPECS.filter((s) => s.kind !== 'claude');

  return (
    <div>
      <PageHeader title="Updates" />

      <PageSection title="Agentrium">
        <div className="flex items-center justify-between py-2 px-1">
          <div>
            <p className="text-text-primary text-[13px]">v{appVersion}</p>
            {appUpdater.status === 'available' && appUpdater.updateInfo && (
              <p className="text-accent-primary text-[11px] mt-1">
                Update available: v{appUpdater.updateInfo.version}
              </p>
            )}
          </div>
          <div className="flex gap-2">
            {appUpdater.status === 'up-to-date' ? (
              <div className="flex items-center gap-2 bg-success/10 text-success h-9 px-4 rounded-md text-[12px] font-medium">
                <Check size={14} /> Up to date
              </div>
            ) : appUpdater.status === 'ready' ? (
              <Button variant="success" onClick={appUpdater.restart} icon={<Rocket size={14} />}>
                Restart to Update
              </Button>
            ) : appUpdater.status === 'downloading' ? (
              <div className="flex items-center gap-2 bg-elevation-1 text-text-primary h-9 px-4 rounded-md text-[12px] font-medium">
                <RefreshCw size={14} className="animate-spin" /> {appUpdater.downloadProgress}%
              </div>
            ) : appUpdater.status === 'available' ? (
              <Button variant="primary" onClick={() => appUpdater.downloadAndInstall()} icon={<Download size={14} />}>
                Download Update
              </Button>
            ) : (
              <Button
                variant="secondary"
                onClick={appUpdater.checkForUpdates}
                disabled={appUpdater.status === 'checking'}
                icon={<RefreshCw size={14} className={appUpdater.status === 'checking' ? 'animate-spin' : ''} />}
              >
                Check for Updates
              </Button>
            )}
          </div>
        </div>
        {appUpdater.error && (
          <div className="text-[11px] p-2 rounded bg-error/10 text-error space-y-2 my-2">
            <p>{appUpdater.error}</p>
            <button
              onClick={() => invoke('open_external_url', { url: 'https://github.com/talayash/agentrium/releases/latest' })}
              className="flex items-center gap-1.5 text-accent-primary hover:text-accent-secondary"
            >
              <ExternalLink size={12} /> Download manually from GitHub
            </button>
          </div>
        )}
      </PageSection>

      {/* Claude Code CLI: the only agent with a full check + update backend. */}
      <PageSection
        title={
          <span className="flex items-center gap-2">
            <BrandIcon kind="claude" size={14} />
            {claudeSpec.displayName}
          </span>
        }
      >
        <div className="flex items-center justify-between py-2 px-1">
          <div>
            <p className="text-text-primary text-[13px]">{isChecking ? 'Checking…' : claudeVersion || 'Not installed'}</p>
            {latestVersion && updateAvailable && (
              <p className="text-accent-primary text-[11px] mt-1">Update available: v{latestVersion}</p>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() => invoke('open_external_url', { url: claudeSpec.installUrl })}
              icon={<ExternalLink size={12} />}
            >
              Docs
            </Button>
            {updateAvailable === false ? (
              <div className="flex items-center gap-2 bg-success/10 text-success h-9 px-4 rounded-md text-[12px] font-medium">
                <Check size={14} /> Up to date
              </div>
            ) : (
              <Button
                variant={updateAvailable ? 'primary' : 'secondary'}
                onClick={updateClaude}
                disabled={isUpdating || isChecking}
                loading={isUpdating || isChecking}
                icon={updateAvailable === null ? <AlertCircle size={14} /> : <Download size={14} />}
              >
                {isUpdating ? 'Updating…' : 'Update'}
              </Button>
            )}
          </div>
        </div>
      </PageSection>

      {otherAgents.map((spec: AgentSpec) => (
        <AgentUpdateSection key={spec.kind} spec={spec} />
      ))}
    </div>
  );
}

// Kept so future refactors can reference the enum value alongside the spec.
export type { AgentKind };
