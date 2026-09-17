import { useEffect } from 'react';
import { useTerminalStore } from '../store/terminalStore';
import { refreshSessionContext } from '../lib/sessionContext';

export function useSessionContext() {
  useEffect(() => {
    let cancelled = false;
    let busy = false;
    const loaded = new Set<string>();
    const attempts = new Map<string, number>();
    const tick = async () => {
      if (cancelled || busy) return;
      busy = true;
      try {
        const terminals = useTerminalStore.getState().terminals;
        for (const id of loaded) {
          if (!terminals.has(id)) { loaded.delete(id); attempts.delete(id); }
        }
        for (const [id, terminal] of terminals) {
          if (cancelled) break;
          if (terminal.isShellTerminal || terminal.scriptName || terminal.scriptParentId) continue;
          try {
            if (!loaded.has(id)) {
              await refreshSessionContext(id, false, true);
              loaded.add(id);
            }
            if (cancelled) break;
            const current = useTerminalStore.getState().terminals.get(id);
            if (!current || current.sessionContext) continue;
            const now = Date.now();
            const previous = attempts.get(id);
            if (previous !== undefined && now - previous < 30_000) continue;
            attempts.set(id, now);
            await refreshSessionContext(id);
          } catch {
            // Optional local metadata must not interrupt this or other terminals.
          }
        }
      } finally {
        busy = false;
      }
    };
    const timer = window.setInterval(() => { void tick(); }, 5000);
    void tick();
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);
}
