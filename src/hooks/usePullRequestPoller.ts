// Polls PR status for branches that have a tracked PR (prStore refs) and
// turns CI failures and merges into attention items + desktop notifications.
// Mounted once in App.tsx. One gh/glab call per branch, not per tab.

import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTerminalStore } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import { usePrStore } from '../store/prStore';
import { useAttentionStore } from '../store/attentionStore';
import { terminalPrTarget, type PrTarget } from '../lib/pullRequestActions';
import { prTransitions, type PrEvent, type PullRequestStatus } from '../lib/pullRequests';
import { isWithinDnd, playNotificationSound } from '../lib/notificationGate';
import { sessionDisplayName } from '../lib/sessionContext';
import { useNotification } from './useNotification';
import { useWindowFocused } from './useWindowFocused';

/** Visible tab in a focused window. */
export const VISIBLE_INTERVAL_MS = 60_000;
/** Background tabs, or any tab while the window is unfocused. */
export const BACKGROUND_INTERVAL_MS = 300_000;
const TICK_MS = 15_000;

/** Tabs on screen: the active one, plus the split pair or grid cells. */
export function visibleTerminalIds(): Set<string> {
  const app = useAppStore.getState();
  const ids = new Set<string>();
  const active = useTerminalStore.getState().activeTerminalId;
  if (app.gridMode) app.gridTerminalIds.forEach(id => ids.add(id));
  else if (app.splitMode && app.splitTerminalIds) app.splitTerminalIds.forEach(id => ids.add(id));
  if (active && !app.gridMode) ids.add(active);
  return ids;
}

export interface PollOptions {
  focused: boolean;
  now: number;
  /** Last poll time per PR key, owned by the caller across ticks. */
  lastPolled: Map<string, number>;
  inFlight: Set<string>;
  notify: (title: string, body: string) => void;
}

function eventCopy(e: PrEvent, branch: string): { title: string; detail: string } {
  const s = e.status;
  if (e.kind === 'merged') return { title: `PR #${s.number} merged`, detail: `${branch} was merged. You can finish the task or close the session.` };
  const names = s.ci.failing.map(c => c.name).slice(0, 3).join(', ');
  return {
    title: `CI failing on PR #${s.number}`,
    detail: names ? `Failing: ${names}${s.ci.failing.length > 3 ? ` and ${s.ci.failing.length - 3} more` : ''}.` : 'A check failed on this pull request.',
  };
}

/** One poller tick. Exported for tests. */
export async function pollPullRequests(opts: PollOptions): Promise<void> {
  const { refs } = usePrStore.getState();
  if (Object.keys(refs).length === 0) return;
  const visible = visibleTerminalIds();

  // Group the open terminals by PR key.
  const groups = new Map<string, { target: PrTarget; terminalIds: string[]; visible: boolean }>();
  for (const id of useTerminalStore.getState().terminals.keys()) {
    const target = terminalPrTarget(id);
    if (!target || !refs[target.key]) continue;
    const g = groups.get(target.key);
    if (g) {
      g.terminalIds.push(id);
      g.visible ||= visible.has(id);
    } else {
      groups.set(target.key, { target, terminalIds: [id], visible: visible.has(id) });
    }
  }

  await Promise.all([...groups].map(async ([key, g]) => {
    const interval = opts.focused && g.visible ? VISIBLE_INTERVAL_MS : BACKGROUND_INTERVAL_MS;
    const last = opts.lastPolled.get(key);
    if (opts.inFlight.has(key) || (last !== undefined && opts.now - last < interval)) return;
    opts.inFlight.add(key);
    opts.lastPolled.set(key, opts.now);
    let status: PullRequestStatus | null;
    try {
      status = await invoke<PullRequestStatus | null>('get_pull_request_status', { path: g.target.path, branch: g.target.branch });
    } catch {
      // Background poll: offline, signed out, or rate limited. The chip keeps
      // its last known state and the next tick retries; the backend already
      // reports real (non-user) failures through wrap_cmd.
      return;
    } finally {
      opts.inFlight.delete(key);
    }
    // null: no signed-in CLI for this remote, or the PR is gone. Keep the ref.
    if (!status) return;

    const store = usePrStore.getState();
    const ref = store.refs[key];
    if (!ref) return; // untracked while the request was in flight
    // A different number means a newer PR now heads this branch: rebaseline.
    const events = ref.number === status.number ? prTransitions(ref, status) : [];
    store.updateRef(key, { url: status.url, number: status.number, provider: status.provider, lastState: status.state, lastCi: status.ci.state });
    store.setStatus(key, status);
    if (events.length === 0) return;

    // Attribute to a visible tab when there is one, else the first.
    const terminals = useTerminalStore.getState().terminals;
    const terminalId = g.terminalIds.find(id => visible.has(id)) ?? g.terminalIds[0];
    const terminal = terminals.get(terminalId);
    const name = terminal ? sessionDisplayName(terminal) : g.target.branch;
    const app = useAppStore.getState();
    const lookingAtIt = opts.focused && useTerminalStore.getState().activeTerminalId === terminalId;
    const dnd = app.dndEnabled && isWithinDnd(app.dndStart, app.dndEnd, new Date(opts.now));
    for (const e of events) {
      const copy = eventCopy(e, g.target.branch);
      useAttentionStore.getState().put({
        terminalId, targetId: terminalId, kind: e.kind === 'merged' ? 'merged' : 'ci',
        title: name, detail: copy.detail, url: status.url,
      });
      if (!lookingAtIt && !dnd) {
        opts.notify(copy.title, `${name}: ${copy.detail}`);
        if (app.notificationSoundEnabled) playNotificationSound();
      }
    }
  }));
}

export function usePullRequestPoller(): void {
  const { notify } = useNotification();
  const focused = useWindowFocused();
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const lastPolled = useRef(new Map<string, number>());
  const inFlight = useRef(new Set<string>());

  useEffect(() => {
    const tick = () => {
      void pollPullRequests({
        focused: focusedRef.current, now: Date.now(),
        lastPolled: lastPolled.current, inFlight: inFlight.current,
        notify: (t, b) => { void notify(t, b); },
      });
    };
    tick();
    const interval = setInterval(tick, TICK_MS);
    // A newly tracked PR (just created, or found by the modal) shows its
    // status right away instead of waiting for the next tick.
    const unsub = usePrStore.subscribe((s, prev) => { if (s.refs !== prev.refs && Object.keys(s.refs).length > Object.keys(prev.refs).length) tick(); });
    return () => { clearInterval(interval); unsub(); };
    // focused is read through focusedRef so focus changes don't recreate the
    // interval; notify is stable (useCallback).
  }, [notify]);
}
