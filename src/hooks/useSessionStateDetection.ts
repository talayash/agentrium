// Single global poller that infers each Claude terminal's session state every
// 500ms and fires an attention notification when a session becomes blocked
// waiting for the user. Mounted once (see App.tsx).

import { useEffect, useRef } from 'react';
import type { Terminal } from '@xterm/xterm';
import { useTerminalStore } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import { getLastOutputAt } from '../lib/terminalActivity';
import { classifySettled, type SessionState } from '../lib/terminalState';
import { isWithinDnd, playNotificationSound } from '../lib/notificationGate';
import { useNotification } from './useNotification';
import { useWindowFocused } from './useWindowFocused';

const POLL_INTERVAL_MS = 500;
const BUSY_WINDOW_MS = 600;
const BUFFER_TAIL_ROWS = 15;

/** Read the bottom `rows` lines of xterm's already-parsed buffer as clean text. */
function readBufferTail(term: Terminal, rows: number): string[] {
  const buf = term.buffer.active;
  const end = buf.length;
  const start = Math.max(0, end - rows);
  const out: string[] = [];
  for (let i = start; i < end; i++) {
    const line = buf.getLine(i);
    out.push(line ? line.translateToString(true) : '');
  }
  return out;
}

export function useSessionStateDetection(): void {
  const { notify } = useNotification();
  const windowFocused = useWindowFocused();

  // Keep focus readable inside the interval without re-creating it.
  const focusedRef = useRef(windowFocused);
  focusedRef.current = windowFocused;

  // Terminals we've already notified for the current waiting episode.
  const notifiedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const interval = setInterval(() => {
      const store = useTerminalStore.getState();
      const app = useAppStore.getState();
      const now = Date.now();

      for (const [id, inst] of store.terminals) {
        // Claude terminals only — skip plain shells and script children.
        if (inst.scriptParentId || inst.isShellTerminal) continue;

        // Exited process: pin to stopped and re-arm notifications.
        if (inst.config.status === 'Stopped') {
          store.setTerminalState(id, 'stopped');
          notifiedRef.current.delete(id);
          continue;
        }

        let state: SessionState;
        const last = getLastOutputAt(id);
        if (last != null && now - last < BUSY_WINDOW_MS) {
          state = 'busy';
        } else if (inst.xterm) {
          state = classifySettled(readBufferTail(inst.xterm, BUFFER_TAIL_ROWS));
        } else {
          // No mounted buffer to read — keep the last known state.
          state = store.terminalStates.get(id) ?? 'idle';
        }

        const prev = store.terminalStates.get(id);
        store.setTerminalState(id, state);

        if (state === 'waiting') {
          const lookingAtIt = id === store.activeTerminalId && focusedRef.current;
          const dnd = app.dndEnabled && isWithinDnd(app.dndStart, app.dndEnd, new Date());
          if (prev !== 'waiting' && !lookingAtIt && !dnd && !notifiedRef.current.has(id)) {
            const name = inst.config.nickname || inst.config.label;
            notify('Claude needs your input', `${name} is waiting for your response.`);
            if (app.notificationSoundEnabled) playNotificationSound();
            notifiedRef.current.add(id);
          }
        } else {
          // Left the waiting episode — re-arm for the next prompt.
          notifiedRef.current.delete(id);
        }
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [notify]);
}
