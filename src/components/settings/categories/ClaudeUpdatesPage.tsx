import { useState, useEffect } from 'react';
import { Download, RefreshCw, AlertCircle, ExternalLink, Check, Rocket } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { useUpdaterStore } from '../../../store/updaterStore';
import { toast } from '../../../store/toastStore';
import { PageHeader, PageSection } from '../SettingRow';
import { Button } from '../../ui/Button';
import { registerSetting } from '../index';

registerSetting({
  category: { group: 'claude', page: 'updates' },
  id: 'app-and-cli-updates',
  label: 'App + Claude CLI updates',
  keywords: ['update', 'upgrade', 'app', 'cli', 'version'],
});

interface UpdateCheckResult {
  current_version: string;
  latest_version: string;
  update_available: boolean;
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

  return (
    <div>
      <PageHeader title="Updates" />

      <PageSection title="ClaudeTerminal">
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
              onClick={() => invoke('open_external_url', { url: 'https://github.com/talayash/claude-terminal/releases/latest' })}
              className="flex items-center gap-1.5 text-accent-primary hover:text-accent-secondary"
            >
              <ExternalLink size={12} /> Download manually from GitHub
            </button>
          </div>
        )}
      </PageSection>

      <PageSection title="Claude Code CLI">
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
              onClick={() => invoke('open_external_url', { url: 'https://docs.anthropic.com/en/docs/claude-code' })}
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
    </div>
  );
}
