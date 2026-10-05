// Single global poller that infers each Claude terminal's session state every
// 500ms and alerts for blocking prompts and completed turns. Completion needs
// a ready input prompt plus evidence of a turn; silence alone is insufficient.
// Mounted once (see App.tsx).

import { useEffect, useRef } from 'react';
import type { Terminal } from '@xterm/xterm';
import { useTerminalStore } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import { getLastOutputAt, getLastSubmissionAt } from '../lib/terminalActivity';
import { classifySettled, hasReadyPrompt, hasTurnFinishedMarker, type SessionState } from '../lib/terminalState';
import { isWithinDnd, playNotificationSound } from '../lib/notificationGate';
import { useNotification } from './useNotification';
import { useWindowFocused } from './useWindowFocused';
import { useSessionAttentionStore } from '../store/sessionAttentionStore';

const POLL_INTERVAL_MS = 500;
const BUSY_WINDOW_MS = 600;
const BUFFER_TAIL_ROWS = 15;
const SOUND_INTERVAL_MS = 4000;
const COMPLETION_QUIET_MS = 1500;

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
  const lastSoundRef = useRef<number>(-Infinity);
  const completedRef = useRef(new Set<string>());
  const submissionsRef = useRef(new Map<string, number>());

  useEffect(() => {
    const interval = setInterval(() => {
      const store = useTerminalStore.getState();
      const app = useAppStore.getState();
      const now = Date.now();
      const attention = useSessionAttentionStore.getState();
      const dnd = app.dndEnabled && isWithinDnd(app.dndStart, app.dndEnd, new Date());
      let needsSound = false;
      let newAlert = false;
      for (const id of new Set([...attention.pending, ...attention.acknowledged, ...notifiedRef.current, ...completedRef.current, ...submissionsRef.current.keys()])) {
        if (!store.terminals.has(id)) {
          attention.clear(id);
          notifiedRef.current.delete(id);
          completedRef.current.delete(id);
          submissionsRef.current.delete(id);
        }
      }

      for (const [id, inst] of store.terminals) {
        // Claude terminals only - skip plain shells and script children.
        if (inst.scriptParentId || inst.isShellTerminal) {
          completedRef.current.delete(id);
          attention.clear(id);
          notifiedRef.current.delete(id);
          continue;
        }

        // Exited process: pin to stopped and re-arm notifications.
        if (inst.config.status === 'Stopped' || inst.config.status === 'Error') {
          completedRef.current.delete(id);
          store.setTerminalState(id, 'stopped');
          notifiedRef.current.delete(id);
          attention.clear(id);
          continue;
        }

        let state: SessionState;
        const last = getLastOutputAt(id);
        const submitted = getLastSubmissionAt(id);
        if (submitted != null && submissionsRef.current.get(id) !== submitted) {
          submissionsRef.current.set(id, submitted);
          completedRef.current.delete(id);
          notifiedRef.current.delete(id);
          attention.clear(id);
        }
        const lines = inst.xterm ? readBufferTail(inst.xterm, BUFFER_TAIL_ROWS) : [];
        if (last != null && now - last < BUSY_WINDOW_MS) {
          state = 'busy';
        } else if (inst.xterm) {
          state = classifySettled(lines);
        } else {
          // No mounted buffer to read - keep the last known state.
          state = store.terminalStates.get(id) ?? 'idle';
        }

        store.setTerminalState(id, state);

        const completed = state === 'idle' && hasReadyPrompt(lines)
          && last != null && now - last >= COMPLETION_QUIET_MS
          && (submitted != null ? last > submitted : hasTurnFinishedMarker(lines));
        if (completed) completedRef.current.add(id);

        if (state === 'waiting' || completedRef.current.has(id)) {
          const lookingAtIt = id === store.activeTerminalId && focusedRef.current;
          attention.request(id);
          if (lookingAtIt) attention.acknowledge(id);
          const pending = useSessionAttentionStore.getState().pending.has(id);
          if (pending && !dnd && !notifiedRef.current.has(id)) {
            const name = inst.config.nickname || inst.config.label;
            notify(completedRef.current.has(id) ? 'Response ready' : 'Session needs your input',
              completedRef.current.has(id) ? `${name} has finished. Open the session to review its response.` : `${name} is waiting for your response.`);
            notifiedRef.current.add(id);
            newAlert = true;
          }
          if (pending && !dnd) needsSound = true;
        } else {
          // Left the waiting episode - re-arm for the next prompt.
          notifiedRef.current.delete(id);
          attention.clear(id);
        }
      }
      // One shared sound cadence, even when several sessions need attention.
      // Without repeat, sound only when a new alert starts (the pre-#88 behavior).
      const soundDue = app.notificationSoundRepeat
        ? needsSound && now - lastSoundRef.current >= SOUND_INTERVAL_MS
        : newAlert;
      if (soundDue && app.notificationSoundEnabled) {
        playNotificationSound();
        lastSoundRef.current = now;
      }
      if (!needsSound) lastSoundRef.current = -Infinity;
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
    // windowFocused is read via focusedRef inside the interval, so it is
    // intentionally omitted here - no need to recreate the interval on focus
    // change. notify is stable (useCallback).
  }, [notify]);
}
