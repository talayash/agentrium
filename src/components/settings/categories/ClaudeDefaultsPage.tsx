import { useState, useEffect } from 'react';
import { useAppStore } from '../../../store/appStore';
import { PageHeader, PageSection, SettingRow } from '../SettingRow';
import { registerSetting } from '../index';

const cat = { group: 'claude', page: 'defaults' } as const;
['default-args', 'default-model', 'binary-path'].forEach((id) =>
  registerSetting({ category: cat, id, label: id.replace(/-/g, ' '), keywords: ['claude', 'args', id] })
);

export default function ClaudeDefaultsPage() {
  const defaultClaudeArgs = useAppStore((s) => s.defaultClaudeArgs);
  const claudeDefaultModel = useAppStore((s) => s.claudeDefaultModel);
  const claudeBinaryPathOverride = useAppStore((s) => s.claudeBinaryPathOverride);
  const { setDefaultClaudeArgs, setClaudeDefaultModel, setClaudeBinaryPathOverride } = useAppStore.getState();

  const [argsText, setArgsText] = useState(defaultClaudeArgs.join('\n'));
  useEffect(() => { setArgsText(defaultClaudeArgs.join('\n')); }, [defaultClaudeArgs]);

  return (
    <div>
      <PageHeader title="Claude Code — Defaults" />

      <PageSection title="Arguments">
        <SettingRow
          label="Default Claude arguments"
          description="Pre-filled when creating a new terminal. One argument per line."
          align="start"
        >
          <textarea
            rows={4} value={argsText}
            onChange={(e) => setArgsText(e.target.value)}
            onBlur={() => setDefaultClaudeArgs(argsText.split('\n').filter(Boolean))}
            placeholder={`--dangerously-skip-permissions\n--model opus`}
            className="w-72 bg-elevation-0 text-text-primary text-[12px] px-2 py-1 rounded ring-1 ring-border-light font-mono resize-y"
          />
        </SettingRow>
        <SettingRow label="Default model">
          <select
            value={claudeDefaultModel ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              setClaudeDefaultModel(v === '' ? null : (v as 'opus' | 'sonnet' | 'haiku'));
            }}
            className="bg-elevation-0 text-text-primary text-[12px] px-2 py-1 rounded ring-1 ring-border-light"
          >
            <option value="">No preference</option>
            <option value="opus">Opus</option>
            <option value="sonnet">Sonnet</option>
            <option value="haiku">Haiku</option>
          </select>
        </SettingRow>
      </PageSection>

      <PageSection title="Binary">
        <SettingRow
          label="Claude binary path override"
          description="Empty = auto-detect from PATH / claude_path module."
        >
          <input
            type="text"
            placeholder="e.g. C:\Users\me\AppData\Roaming\npm\claude.cmd"
            value={claudeBinaryPathOverride}
            onChange={(e) => setClaudeBinaryPathOverride(e.target.value)}
            className="w-80 bg-elevation-0 text-text-primary text-[12px] px-2 py-1 rounded ring-1 ring-border-light font-mono"
          />
        </SettingRow>
      </PageSection>
    </div>
  );
}
