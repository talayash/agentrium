import { useEffect } from 'react';
import { useTerminalStore } from '../store/terminalStore';
import { getLastOutputAt } from '../lib/terminalActivity';
import { captureSessionScreen, refreshSessionContext } from '../lib/sessionContext';

export function useSessionContext() {
  useEffect(() => {
    let cancelled = false;
    let busy = false;
    const loaded = new Set<string>();
    const observedAt = new Map<string, number>();
    const attempts = new Map<string, { time: number; screen: string }>();
    const tick = async () => {
      if (cancelled || busy) return;
      busy = true;
      try {
        const terminals = useTerminalStore.getState().terminals;
        for (const id of loaded) {
          if (!terminals.has(id)) { loaded.delete(id); attempts.delete(id); observedAt.delete(id); }
        }
        for (const [id, terminal] of terminals) {
          if (cancelled) break;
          if (terminal.isShellTerminal || terminal.scriptName || terminal.scriptParentId) continue;
          if (!observedAt.has(id)) observedAt.set(id, Date.now());
          if (!loaded.has(id)) {
            await refreshSessionContext(id, false, true);
            loaded.add(id);
          }
          if (cancelled) break;
          const lastOutput = getLastOutputAt(id);
          const previous = attempts.get(id);
          const now = Date.now();
          // Quiet output schedules enrichment; it never implies task success.
          const needsFirstTitle = !terminal.sessionContext && now - observedAt.get(id)! >= 30_000;
          if (!lastOutput || (!needsFirstTitle && now - lastOutput < 8000) || (previous && now - previous.time < 120_000)) continue;
          const screen = captureSessionScreen(id);
          if (screen.length < 80 || previous?.screen === screen) continue;
          attempts.set(id, { time: now, screen });
          await refreshSessionContext(id);
        }
      } catch {
        // Optional enrichment must not interrupt terminal interaction.
      } finally { busy = false; }
    };
    const timer = window.setInterval(() => { void tick(); }, 5000);
    void tick();
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);
}
