import { useState, useEffect } from 'react';
import { useAppStore } from '../../../store/appStore';
import { PageHeader, PageSection, SettingRow, Toggle } from '../SettingRow';
import { registerSetting } from '../index';
import { CLAUDE_MODELS } from '../../../lib/claudeModels';
import { BUILTIN_AGENT_KINDS, specFor } from '../../../lib/agents';
import { useAgentRegistryStore } from '../../../store/agentRegistryStore';
import { toast } from '../../../store/toastStore';
import { reportInvokeFailure } from '../../../lib/errorReporter';

const cat = { group: 'claude', page: 'defaults' } as const;
['default-args', 'default-model', 'binary-path'].forEach((id) =>
  registerSetting({ category: cat, id, label: id.replace(/-/g, ' '), keywords: ['agent', 'claude', 'codex', 'cursor', 'antigravity', 'custom', 'args', id] })
);
registerSetting({ category: cat, id: 'cost-tracking',  label: 'Track per-session cost', keywords: ['agent', 'cost', 'token', 'telemetry', 'otel', 'budget', 'tracking', 'usage'] });
registerSetting({ category: cat, id: 'session-budget', label: 'Per-session budget cap', keywords: ['agent', 'cost', 'budget', 'cap', 'limit', 'usd', 'spend'] });

function AgentArguments({ name, args, onSave }: {
  name: string;
  args: string[];
  onSave: (args: string[]) => void | Promise<unknown>;
}) {
  const [text, setText] = useState(args.join('\n'));
  const [saving, setSaving] = useState(false);
  useEffect(() => { setText(args.join('\n')); }, [args]);

  const save = async () => {
    const next = text.split('\n').map(arg => arg.trim()).filter(Boolean);
    if (JSON.stringify(next) === JSON.stringify(args)) return;
    setSaving(true);
    try {
      await onSave(next);
    } catch (error) {
      toast.error('Could not save agent arguments', String(error));
      reportInvokeFailure('save_custom_agent', error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow label={`${name} arguments`} align="start">
      <textarea
        aria-label={`${name} arguments`}
        rows={3}
        value={text}
        disabled={saving}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => { void save(); }}
        className="w-72 bg-elevation-0 text-text-primary text-[12px] px-2 py-1 rounded ring-1 ring-border-light font-mono resize-y"
      />
    </SettingRow>
  );
}

export default function ClaudeDefaultsPage() {
  const defaultAgentArgs = useAppStore((s) => s.defaultAgentArgs);
  const customAgents = useAgentRegistryStore((s) => s.customAgents);
  const saveAgent = useAgentRegistryStore((s) => s.saveAgent);
  const claudeDefaultModel = useAppStore((s) => s.claudeDefaultModel);
  const claudeBinaryPathOverride = useAppStore((s) => s.claudeBinaryPathOverride);
  const costTrackingEnabled = useAppStore((s) => s.costTrackingEnabled);
  const sessionBudgetUsd = useAppStore((s) => s.sessionBudgetUsd);
  const {
    setDefaultAgentArgs, setClaudeDefaultModel, setClaudeBinaryPathOverride,
    setCostTrackingEnabled, setSessionBudgetUsd,
  } = useAppStore.getState();

  return (
    <div>
      <PageHeader title="Agent Defaults" />

      <PageSection title="Arguments" description="Defaults for each agent, pre-filled in new terminals. One argument per line, with flag values on separate lines. Profiles can override these defaults.">
        {BUILTIN_AGENT_KINDS.map((kind) => (
          <AgentArguments
            key={kind}
            name={specFor(kind).displayName}
            args={defaultAgentArgs[kind]}
            onSave={(args) => setDefaultAgentArgs(kind, args)}
          />
        ))}
        {customAgents.map((agent) => (
          <AgentArguments
            key={agent.id}
            name={agent.name}
            args={agent.default_args}
            onSave={(args) => saveAgent({ ...agent, default_args: args })}
          />
        ))}
      </PageSection>

      <PageSection title="Claude Code">
        <SettingRow label="Default Claude model">
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
