import { useState, useEffect } from 'react';
import { ExternalLink, Github } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { PageHeader, PageSection } from '../SettingRow';
import { registerSetting } from '../index';
import { AGENT_SPECS, type AgentKind } from '../../../lib/agents';
import { BrandIcon } from '../../BrandIcon';

registerSetting({
  category: { group: 'privacy-about', page: 'about' },
  id: 'about',
  label: 'About ADE-1',
  keywords: ['version', 'about', 'github', 'license', 'agent'],
});

export default function AboutPage() {
  const [appVersion, setAppVersion] = useState('');
  const [agentVersions, setAgentVersions] = useState<Record<AgentKind, string | null>>({
    claude: null,
    codex: null,
    cursor: null,
    gemini: null,
  });

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
    // Fire all four version checks in parallel; each populates its own
    // slot so a missing agent doesn't block the others from rendering.
    for (const spec of AGENT_SPECS) {
      invoke<string>('get_agent_version', { agent: spec.kind })
        .then((v) => setAgentVersions((prev) => ({ ...prev, [spec.kind]: v || null })))
        .catch(() => setAgentVersions((prev) => ({ ...prev, [spec.kind]: null })));
    }
  }, []);

  return (
    <div>
      <PageHeader title="About ADE-1" />

      <PageSection title="Versions">
        <div className="py-2 text-[12.5px] text-text-primary space-y-1.5">
          <p>ADE-1 <span className="font-mono text-text-secondary">v{appVersion}</span></p>
          {AGENT_SPECS.map((spec) => {
            const version = agentVersions[spec.kind];
            return (
              <p key={spec.kind} className="flex items-center gap-1.5">
                <span className="opacity-70 flex items-center"><BrandIcon kind={spec.kind} size={12} /></span>
                {spec.displayName}{' '}
                <span className="font-mono text-text-secondary">
                  {version ?? 'not installed'}
                </span>
              </p>
            );
          })}
        </div>
      </PageSection>

      <PageSection title="Links">
        <button
          onClick={() => invoke('open_external_url', { url: 'https://github.com/talayash/claude-terminal' })}
          className="flex items-center gap-2 text-accent-primary hover:text-accent-secondary text-[12.5px] py-2"
        >
          <Github size={14} /> github.com/talayash/claude-terminal
        </button>
        {AGENT_SPECS.map((spec) => (
          <button
            key={spec.kind}
            onClick={() => invoke('open_external_url', { url: spec.installUrl })}
            className="flex items-center gap-2 text-accent-primary hover:text-accent-secondary text-[12.5px] py-2"
          >
            <ExternalLink size={14} /> {spec.displayName} documentation
          </button>
        ))}
      </PageSection>
    </div>
  );
}
