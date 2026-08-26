import { useEffect, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { RefreshCw, Download, FileText } from 'lucide-react';
import { Button } from '../../ui/Button';
import { useAppStore } from '../../../store/appStore';
import { PageHeader, PageSection, SettingRow, Toggle } from '../SettingRow';
import { registerSetting } from '../index';
import { toast } from '../../../store/toastStore';

registerSetting({
  category: { group: 'editor', page: 'language-servers' },
  id: 'lsp-enabled',
  label: 'Enable language servers',
  keywords: ['lsp', 'diagnostics', 'intellisense', 'squiggles', 'language server'],
});

interface LangStatus {
  language: string;
  resolution:
    | { kind: 'path'; program: string; version: string | null }
    | { kind: 'installed'; program: string }
    | { kind: 'missing' };
  running_roots: string[];
}

const LABELS: Record<string, string> = {
  typescript: 'TypeScript / JavaScript',
  python: 'Python (Pyright)',
  rust: 'Rust (rust-analyzer)',
};

export default function LanguageServersPage() {
  const lspEnabled = useAppStore((s) => s.lspEnabled);
  const setLspEnabled = useAppStore((s) => s.setLspEnabled);
  const [statuses, setStatuses] = useState<LangStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);
  const [logFor, setLogFor] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);

  const refresh = useCallback(() => {
    invoke<LangStatus[]>('lsp_status')
      .then(setStatuses)
      .catch(() => setStatuses([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    const un = listen('lsp-status', refresh);
    return () => {
      un.then((f) => f());
    };
  }, [refresh]);

  const install = async (language: string) => {
    setInstalling(language);
    try {
      await invoke<string>('lsp_install_server', { language });
      toast.success('Installed', `${LABELS[language] ?? language} language server is ready`);
      refresh();
    } catch (err) {
      toast.error('Install failed', typeof err === 'string' ? err : 'Unknown error');
    } finally {
      setInstalling(null);
    }
  };

  const restart = async (language: string) => {
    await invoke('lsp_restart_server', { language }).catch(() => {});
    refresh();
  };

  const showLog = async (language: string) => {
    if (logFor === language) {
      setLogFor(null);
      return;
    }
    const lines = await invoke<string[]>('lsp_server_log', { language }).catch(() => []);
    setLogLines(lines as string[]);
    setLogFor(language);
  };

  return (
    <div>
      <PageHeader
        title="Editor - Language Servers"
        description="LSP-based diagnostics, completions, and hover docs inside ADE-1's file editor."
      />

      <PageSection title="General">
        <SettingRow
          label="Enable language servers"
          description="Start LSP servers for TypeScript, Python, and Rust when editing files."
        >
          <Toggle value={lspEnabled} onChange={setLspEnabled} />
        </SettingRow>
      </PageSection>

      <PageSection title="Servers">
        {loading ? (
          <p className="text-text-tertiary text-[12px] py-2">Loading…</p>
        ) : (
          statuses.map((s) => {
            const label = LABELS[s.language] ?? s.language;
            const res = s.resolution;
            const isRunning = s.running_roots.length > 0;
            const isLogOpen = logFor === s.language;

            return (
              <div key={s.language}>
                <SettingRow label={label}>
                  <div className="flex items-center gap-2">
                    {/* resolution badge */}
                    {res.kind === 'path' && (
                      <span className="text-[12px] text-success">
                        On PATH{res.version ? ` · ${res.version}` : ''}
                      </span>
                    )}
                    {res.kind === 'installed' && (
                      <span className="text-[12px] text-success">
                        Installed
                      </span>
                    )}
                    {res.kind === 'missing' && (
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<Download size={12} />}
                        loading={installing === s.language}
                        onClick={() => install(s.language)}
                      >
                        Install
                      </Button>
                    )}

                    {/* restart */}
                    {isRunning && (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<RefreshCw size={12} />}
                        onClick={() => restart(s.language)}
                        title="Restart server"
                      >
                        Restart
                      </Button>
                    )}

                    {/* log toggle */}
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<FileText size={12} />}
                      onClick={() => showLog(s.language)}
                      title={isLogOpen ? 'Hide log' : 'Show stderr log'}
                    >
                      Log
                    </Button>
                  </div>
                </SettingRow>

                {/* running roots */}
                {isRunning && (
                  <p className="text-text-tertiary text-[11.5px] pb-1 -mt-1">
                    Running in:{' '}
                    {s.running_roots.map((r, i) => (
                      <span key={r}>
                        {i > 0 && ', '}
                        <span className="font-mono">{r}</span>
                      </span>
                    ))}
                  </p>
                )}

                {/* log panel */}
                {isLogOpen && (
                  <pre className="max-h-48 overflow-y-auto text-text-tertiary text-[11px] font-mono bg-elevation-0 rounded p-2 mb-2 whitespace-pre-wrap break-all">
                    {logLines.length > 0
                      ? logLines.join('\n')
                      : 'No stderr output captured.'}
                  </pre>
                )}
              </div>
            );
          })
        )}
      </PageSection>
    </div>
  );
}
