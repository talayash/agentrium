import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { MessageSquare, RefreshCw } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';
import { toast } from '../store/toastStore';
import { allAgentSpecs, defaultArgsFor } from '../lib/agents';
import { loadHistoryGroups, type HistoryGroup, type HistoryProfile, type HistorySession } from '../lib/historyGroups';
import { LatestRequest } from '../lib/latestRequest';
import { reportInvokeFailure } from '../lib/errorReporter';
import type { FrameworkHint } from '../lib/preview/framework';
import { PanelHeader } from './ui/PanelHeader';
import { ListRow } from './ui/ListRow';
import { EmptyState } from './ui/EmptyState';
import { GlassSpinner } from './ui/GlassSpinner';

const agentName = (agent: string) => allAgentSpecs().find(s => s.kind === agent)?.displayName ?? agent;

export function GroupedSessionHistory() {
  const collapsed = useAppStore(s => s.sessionsCollapsed);
  const toggleCollapsed = useAppStore(s => s.toggleSessionsCollapsed);
  const profileModalOpen = useAppStore(s => s.profileModalOpen);
  const [groups, setGroups] = useState<HistoryGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);
  const request = useRef(new LatestRequest());

  const refresh = useCallback(async () => {
    const id = request.current.begin();
    setLoading(true);
    setError(null);
    try {
      const [profiles, folders] = await Promise.allSettled([
        invoke<HistoryProfile[]>('get_profiles'),
        invoke<string[]>('get_session_history_folders'),
      ]);
      const result = await loadHistoryGroups(
        profiles.status === 'fulfilled' ? profiles.value : [],
        folders.status === 'fulfilled' ? folders.value : [],
        () => request.current.isCurrent(id),
      );
      if (!request.current.isCurrent(id)) return;
      setGroups(result);
      if (profiles.status === 'rejected') reportInvokeFailure('get_profiles', profiles.reason);
      if (folders.status === 'rejected') reportInvokeFailure('get_session_history_folders', folders.reason);
      if (profiles.status === 'rejected' || folders.status === 'rejected') {
        setError('Some history sources could not be loaded. Try refreshing.');
      }
    } catch (err) {
      if (request.current.isCurrent(id)) setError(`Could not load history: ${String(err)}`);
    } finally {
      if (request.current.isCurrent(id)) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!collapsed && !profileModalOpen) void refresh();
    return () => request.current.invalidate();
  }, [collapsed, profileModalOpen, refresh]);

  const restore = async (group: HistoryGroup, session: HistorySession) => {
    if (openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    const profile = group.profile;
    const env = { ...profile?.env_vars };
    const bindings = profile?.credential_bindings ?? [];
    for (const binding of bindings) delete env[binding.env];
    let validated = false;
    try {
      await invoke('validate_session_directory', { path: group.cwd });
      validated = true;
      const id = await useTerminalStore.getState().createTerminal(
        profile?.name ?? `Resumed ${session.id.slice(0, 8)}`,
        group.cwd,
        profile
          ? profile.agent_args?.[session.agent] ?? profile.claude_args
          : defaultArgsFor(session.agent, useAppStore.getState().defaultAgentArgs),
        env, undefined, undefined, undefined, session.id, undefined,
        profile?.preview?.enabled ? {
          isOpen: true, userOverride: profile.preview.url_override ?? null,
          frameworkHint: (profile.preview.framework_hint ?? 'unknown') as FrameworkHint,
        } : undefined,
        session.agent, bindings,
      );
      const app = useAppStore.getState();
      if (app.gridMode) app.addToGrid(id);
    } catch (err) {
      toast.error('Could not restore session', String(err));
      // A failed validate is environment (folder moved or unmounted) and is
      // already classified user-facing in Rust; only the spawn is a defect.
      if (validated) reportInvokeFailure('create_terminal', err);
    } finally {
      openingRef.current = false;
      setOpening(false);
    }
  };

  return <div className="flex flex-col h-full min-h-0 overflow-hidden">
    <PanelHeader title="Sessions" count={collapsed ? undefined : groups.reduce((n, g) => n + g.sessions.length, 0)}
      collapsible collapsed={collapsed} onToggleCollapsed={toggleCollapsed}
      progress={{ active: !collapsed && loading }}
      actions={!collapsed ? <button onClick={refresh} disabled={loading || opening} title="Refresh"
        className="w-5 h-5 flex items-center justify-center rounded-md hover:bg-fill-hover text-text-tertiary disabled:opacity-40">
        <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
      </button> : undefined} />
    {!collapsed && <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden pb-1" aria-busy={loading}>
      {error && <p role="alert" className="px-3 py-2 text-red-400 text-[11px]">{error}</p>}
      {loading && groups.length === 0 && <p className="flex items-center gap-2 px-3 py-2 text-text-tertiary text-[11px]">
        <GlassSpinner size={14} />Loading sessions...
      </p>}
      {!loading && !error && groups.length === 0 && <EmptyState icon={<MessageSquare size={20} />}
        title="No saved sessions" description="Sessions from your profiles and previously used folders will appear here." compact />}
      {groups.map(group => <section key={group.id} aria-label={group.name} className="pb-3">
        <div className="px-3 pt-2 pb-1">
          <h3 className="text-[12px] font-medium text-text-primary truncate">{group.name}
            {group.profile && <span className="ml-2 text-[10px] text-text-tertiary">{agentName(group.profile.agent ?? 'claude')}</span>}
          </h3>
          <p className="text-[10.5px] text-text-tertiary truncate" title={group.cwd} dir="ltr">{group.cwd}</p>
        </div>
        <div aria-hidden="true" className="mx-3 mb-1 border-t border-seam" />
        {group.error && <p role="alert" className="px-3 text-red-400 text-[11px]">{group.error}</p>}
        {group.unsupported && <p className="px-3 text-text-tertiary text-[11px]">This agent has no local session index.</p>}
        {!group.error && !group.unsupported && group.sessions.length === 0 && <p className="px-3 text-text-tertiary text-[11px]">No saved sessions</p>}
        {group.sessions.map(session => <ListRow key={`${session.agent}:${session.id}`} disabled={opening}
          onClick={() => void restore(group, session)} title={`Restore ${session.preview || session.id}`}
          leading={<MessageSquare size={11} className="shrink-0 text-text-tertiary" />}
          trailing={<span className="text-[10.5px] text-text-tertiary whitespace-nowrap">{formatRelativeTime(session.modified_at)}</span>}>
          <div className="min-w-0">
            <p className="text-[12px] truncate">{session.preview || `Session ${session.id.slice(0, 8)}`}</p>
            <p className="text-[10px] text-text-tertiary">{agentName(session.agent)}</p>
          </div>
        </ListRow>)}
      </section>)}
    </div>}
  </div>;
}

function formatRelativeTime(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return new Date(time).toLocaleDateString();
}
