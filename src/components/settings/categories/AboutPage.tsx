import { useState, useEffect } from 'react';
import { ExternalLink, Github } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { PageHeader, PageSection } from '../SettingRow';
import { registerSetting } from '../index';

registerSetting({
  category: { group: 'privacy-about', page: 'about' },
  id: 'about',
  label: 'About ClaudeTerminal',
  keywords: ['version', 'about', 'github', 'license'],
});

export default function AboutPage() {
  const [appVersion, setAppVersion] = useState('');
  const [claudeVersion, setClaudeVersion] = useState<string | null>(null);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
    invoke<string>('get_claude_version').then(setClaudeVersion).catch(() => setClaudeVersion(null));
  }, []);

  return (
    <div>
      <PageHeader title="About ClaudeTerminal" />

      <PageSection title="Versions">
        <div className="py-2 text-[12.5px] text-text-primary space-y-1">
          <p>ClaudeTerminal <span className="font-mono text-text-secondary">v{appVersion}</span></p>
          <p>Claude Code CLI <span className="font-mono text-text-secondary">{claudeVersion || 'not installed'}</span></p>
        </div>
      </PageSection>

      <PageSection title="Links">
        <button
          onClick={() => invoke('open_external_url', { url: 'https://github.com/talayash/claude-terminal' })}
          className="flex items-center gap-2 text-accent-primary hover:text-accent-secondary text-[12.5px] py-2"
        >
          <Github size={14} /> github.com/talayash/claude-terminal
        </button>
        <button
          onClick={() => invoke('open_external_url', { url: 'https://docs.anthropic.com/en/docs/claude-code' })}
          className="flex items-center gap-2 text-accent-primary hover:text-accent-secondary text-[12.5px] py-2"
        >
          <ExternalLink size={14} /> Claude Code documentation
        </button>
      </PageSection>
    </div>
  );
}
