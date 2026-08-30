import { useState, useEffect } from 'react';
import { useAppStore } from '../../../store/appStore';
import { PageHeader, PageSection, SettingRow, Toggle } from '../SettingRow';
import { registerSetting } from '../index';
import { CLAUDE_MODELS } from '../../../lib/claudeModels';

const cat = { group: 'claude', page: 'defaults' } as const;
['default-args', 'default-model', 'binary-path'].forEach((id) =>
  registerSetting({ category: cat, id, label: id.replace(/-/g, ' '), keywords: ['claude', 'args', id] })
);
registerSetting({ category: cat, id: 'cost-tracking',  label: 'Track per-session cost', keywords: ['cost', 'token', 'telemetry', 'otel', 'budget', 'tracking', 'usage'] });
registerSetting({ category: cat, id: 'session-budget', label: 'Per-session budget cap', keywords: ['cost', 'budget', 'cap', 'limit', 'usd', 'spend'] });

export default function ClaudeDefaultsPage() {
  const defaultClaudeArgs = useAppStore((s) => s.defaultClaudeArgs);
  const claudeDefaultModel = useAppStore((s) => s.claudeDefaultModel);
  const claudeBinaryPathOverride = useAppStore((s) => s.claudeBinaryPathOverride);
  const costTrackingEnabled = useAppStore((s) => s.costTrackingEnabled);
  const sessionBudgetUsd = useAppStore((s) => s.sessionBudgetUsd);
  const {
    setDefaultClaudeArgs, setClaudeDefaultModel, setClaudeBinaryPathOverride,
    setCostTrackingEnabled, setSessionBudgetUsd,
  } = useAppStore.getState();

  const [argsText, setArgsText] = useState(defaultClaudeArgs.join('\n'));
  useEffect(() => { setArgsText(defaultClaudeArgs.join('\n')); }, [defaultClaudeArgs]);

  return (
    <div>
      <PageHeader title="Claude Code - Defaults" />

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
              setClaudeDefaultModel(v === '' ? null : v);
            }}
            className="bg-elevation-0 text-text-primary text-[12px] px-2 py-1 rounded ring-1 ring-border-light"
          >
            <option value="">No preference</option>
            {/* Skip the synthetic 'default' alias - "No preference" already
                covers that. */}
            {CLAUDE_MODELS.filter(m => m.alias !== 'default').map((m) => (
              <option key={m.alias} value={m.alias}>{m.fullLabel}</option>
            ))}
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

      <PageSection title="Cost tracking" description="Local OpenTelemetry metrics per terminal - no data leaves your machine.">
        <SettingRow label="Track per-session cost" description="Live token & estimated-USD metrics per terminal tab.">
          <Toggle value={costTrackingEnabled} onChange={setCostTrackingEnabled} />
        </SettingRow>
        <SettingRow label="Per-session budget cap (USD)" description="0 = no cap. Warns when a session's estimated cost exceeds this.">
          <input
            type="number"
            min={0}
            step={0.5}
            value={sessionBudgetUsd}
            onChange={(e) => setSessionBudgetUsd(parseFloat(e.target.value) || 0)}
            className="w-20 bg-elevation-0 text-text-primary text-[12px] px-2 py-1 rounded ring-1 ring-border-light tabular-nums"
          />
        </SettingRow>
      </PageSection>
    </div>
  );
}
