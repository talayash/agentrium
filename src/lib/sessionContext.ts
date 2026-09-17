import { invoke } from '@tauri-apps/api/core';
import { useTerminalStore } from '../store/terminalStore';

export interface SessionContext {
  title: string;
  goal: string;
  latest: string;
  updatedAt: string;
  generated: boolean;
}

export function sessionDisplayName(terminal: {
  config: { nickname: string | null; label: string };
  sessionContext?: SessionContext | null;
}): string {
  return terminal.config.nickname || terminal.config.label;
}

export function contextTooltip(name: string, context?: SessionContext | null, summary?: string | null): string {
  if (!context) return summary ? `${name}\n\n${summary}` : `${name}\nDouble-click to rename`;
  const updated = new Date(context.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${name}\n\nGoal: ${context.goal}${context.latest ? `\nLatest: ${context.latest}` : ''}\n\nUpdated ${updated}`;
}

const pending = new Map<string, Promise<boolean>>();

export function refreshSessionContext(id: string, regenerate = false, loadOnly = false): Promise<boolean> {
  const active = pending.get(id);
  if (active) return regenerate
    ? active.catch(() => false).then(() => refreshSessionContext(id, true, loadOnly))
    : active;
  const terminal = useTerminalStore.getState().terminals.get(id);
  if (!terminal || terminal.isShellTerminal || terminal.scriptParentId || terminal.scriptName) return Promise.resolve(false);
  // Preserve IPC compatibility without collecting terminal content.
  const screen = loadOnly ? null : '';
  const request = invoke<SessionContext | null>('get_terminal_context', { id, screen, regenerate })
    .then(context => {
      if (context) useTerminalStore.getState().setSessionContext(id, context);
      return !!context;
    }).finally(() => { pending.delete(id); });
  pending.set(id, request);
  return request;
}
