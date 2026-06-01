# Session State + Smart Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Infer per-terminal Claude state (busy / waiting-for-decision / idle / stopped) from xterm's parsed buffer, surface it in tab indicators and an Agent View, and fire native notifications only when a session is blocked waiting for the user.

**Architecture:** A pure classifier (`classifySettled`) reads the bottom rows of xterm's already-parsed buffer and decides waiting-vs-idle. A single 500ms global poller hook computes each Claude terminal's state (busy from the existing `lastOutputAt` timer; waiting/idle from the classifier when output has settled), writes it to Zustand only on transitions, and fires an attention notification on entry into `waiting` unless the user is already looking at that session. UI reads the state map to render a shared `StateDot` in tabs and the Agent View (the upgraded Recent Terminals dropdown).

**Tech Stack:** React 18 + TypeScript, Zustand, xterm.js (`@xterm/xterm`), Tauri 2 window API (`@tauri-apps/api/window`), Vitest for unit tests.

---

## Background facts (read before starting)

- **Activity tracking already exists.** `src/lib/terminalActivity.ts` keeps a module-level `Map<id, lastOutputAt>` updated on every output chunk (deliberately bypassing Zustand to avoid re-renders). Read it with `getLastOutputAt(id)`. We reuse this for the `busy` state.
- **xterm persists for all tabs.** `terminalStore.handleTerminalOutput` writes to `instance.xterm` regardless of which tab is active, so background terminals have a live, parsed buffer we can read.
- **Reduce-motion is global CSS.** `index.css` disables all animation under `:root[data-reduce-motion="true"]`. The pulsing dot therefore needs no per-component reduce-motion handling.
- **DND/sound settings exist but are not enforced anywhere yet.** `appStore` has `dndStart`, `dndEnd` (both `"HH:MM"`), and `notificationSoundEnabled`. The current finish notification (`App.tsx`) ignores them. Our gate is the first enforcement.
- **Test runner:** Vitest. Run a single file with `npx vitest run <path>`. Existing example: `src/lib/terminalActivity.test.ts`.
- **Claude terminals only.** Skip instances where `isShellTerminal` or `scriptParentId` is set.

## File Structure

- Create `src/lib/terminalState.ts` — pure classifier + `SessionState` type + pattern lists. One responsibility: turn screen text into a state verdict.
- Create `src/lib/terminalState.test.ts` — classifier unit tests.
- Create `src/lib/notificationGate.ts` — pure `isWithinDnd()` + best-effort `playNotificationSound()`.
- Create `src/lib/notificationGate.test.ts` — DND-window unit tests.
- Create `src/hooks/useWindowFocused.ts` — boolean app-window focus via Tauri.
- Create `src/hooks/useSessionStateDetection.ts` — the global poller; owns buffer reading + transition/notification logic.
- Create `src/components/StateDot.tsx` — shared state dot, used by tabs, Agent View, grid.
- Modify `src/store/terminalStore.ts` — add `terminalStates` map + `setTerminalState` + cleanup.
- Modify `src/components/TerminalTabs.tsx` — replace binary working dot with `StateDot`.
- Modify `src/components/titlebar/RecentTerminalsMenu.tsx` — Agent View: state pills, waiting-first sort, count badge on the icon.
- Modify `src/App.tsx` — mount `useSessionStateDetection()`.

---

## Task 1: SessionState type + pure classifier

**Files:**
- Create: `src/lib/terminalState.ts`
- Test: `src/lib/terminalState.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/terminalState.test.ts
import { describe, it, expect } from 'vitest';
import { classifySettled } from './terminalState';

describe('classifySettled', () => {
  it('flags a "Do you want to proceed?" permission prompt as waiting', () => {
    const lines = [
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. No, tell Claude what to do differently',
    ];
    expect(classifySettled(lines)).toBe('waiting');
  });

  it('flags an AskUserQuestion numbered menu as waiting', () => {
    const lines = [
      'Which approach should I take?',
      '❯ 1. Rewrite the module',
      '  2. Patch in place',
      '  3. Leave it',
    ];
    expect(classifySettled(lines)).toBe('waiting');
  });

  it('flags the folder-trust prompt as waiting', () => {
    const lines = [
      'Do you trust the files in this folder?',
      '❯ 1. Yes, proceed',
      '  2. No, exit',
    ];
    expect(classifySettled(lines)).toBe('waiting');
  });

  it('treats the plain idle input box as idle', () => {
    const lines = [
      '╭───────────────────────────────╮',
      '│ >                             │',
      '╰───────────────────────────────╯',
      '  ? for shortcuts',
    ];
    expect(classifySettled(lines)).toBe('idle');
  });

  it('does not raise waiting on a finished response that contains a numbered list', () => {
    const lines = [
      'Here are the steps I took:',
      '1. Updated the parser',
      '2. Added a test',
      '╭───────────────────────────────╮',
      '│ >                             │',
      '╰───────────────────────────────╯',
      '  ? for shortcuts',
    ];
    expect(classifySettled(lines)).toBe('idle');
  });

  it('treats mid-stream prose with no prompt as idle (never a false alarm)', () => {
    const lines = [
      '● Running the test suite…',
      '  Updated src/foo.ts with 3 additions',
      'Now I will check the output.',
    ];
    expect(classifySettled(lines)).toBe('idle');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/terminalState.test.ts`
Expected: FAIL — "Failed to resolve import './terminalState'" / `classifySettled is not a function`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/terminalState.ts

/** Inferred state of a Claude Code terminal. */
export type SessionState = 'busy' | 'waiting' | 'idle' | 'stopped';

/**
 * Phrases that unambiguously mean Claude is blocked waiting for a decision.
 * Kept as an exported, versioned list so they are cheap to tune as Claude
 * Code's prompt UI changes. Matched against the joined, trimmed tail text.
 */
export const WAITING_PATTERNS: RegExp[] = [
  /Do you want to proceed\??/i,
  /Do you trust the files in this folder\??/i,
  /\(y\/n\)/i,
  /\[y\/N\]/,
];

/**
 * Markers that mean the plain input box is on screen — i.e. Claude is idle and
 * ready for a new prompt, even if a numbered list from the last response is
 * still visible above the box.
 */
const IDLE_MARKERS: RegExp[] = [
  /\?\s+for\s+shortcuts/i,
  /^[│|]?\s*>\s*$/,
];

/** A selectable option line, e.g. "❯ 1. Yes" or "2. No". */
const OPTION_LINE = /^(?:❯\s*)?\d+\.\s+\S/;

/**
 * Decide whether settled terminal output represents a blocking prompt
 * (`waiting`) or a ready input box (`idle`). Only called once output has gone
 * quiet — `busy` is handled by the caller via the activity timer.
 *
 * Bias: when uncertain, return `idle`. A missed prompt is a minor annoyance;
 * a false "needs attention" alarm erodes trust in the whole feature.
 */
export function classifySettled(lines: string[]): 'waiting' | 'idle' {
  const trimmed = lines.map((l) => l.trim());
  const joined = trimmed.join('\n');

  // 1. Explicit blocking phrases win immediately.
  for (const re of WAITING_PATTERNS) {
    if (re.test(joined)) return 'waiting';
  }

  // 2. If the plain input box is visible, Claude is idle regardless of any
  //    numbered list left over from its last response.
  if (IDLE_MARKERS.some((re) => trimmed.some((l) => re.test(l)))) return 'idle';

  // 3. Two or more option lines = a selection menu (AskUserQuestion / picker).
  const optionLines = trimmed.filter((l) => OPTION_LINE.test(l));
  if (optionLines.length >= 2) return 'waiting';

  return 'idle';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/terminalState.test.ts`
Expected: PASS (6 passed).

- [ ] **Step 5: Commit**

```bash
git add src/lib/terminalState.ts src/lib/terminalState.test.ts
git commit -m "feat: pure classifier for Claude terminal session state"
```

---

## Task 2: Notification gate (DND window + sound)

**Files:**
- Create: `src/lib/notificationGate.ts`
- Test: `src/lib/notificationGate.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/notificationGate.test.ts
import { describe, it, expect } from 'vitest';
import { isWithinDnd } from './notificationGate';

function at(hh: number, mm: number): Date {
  const d = new Date(2026, 5, 1, hh, mm, 0, 0);
  return d;
}

describe('isWithinDnd', () => {
  it('returns false when start equals end (window disabled)', () => {
    expect(isWithinDnd('00:00', '00:00', at(3, 0))).toBe(false);
  });

  it('handles a same-day window (09:00–17:00)', () => {
    expect(isWithinDnd('09:00', '17:00', at(12, 0))).toBe(true);
    expect(isWithinDnd('09:00', '17:00', at(8, 59))).toBe(false);
    expect(isWithinDnd('09:00', '17:00', at(17, 0))).toBe(false); // end exclusive
  });

  it('handles an overnight window (22:00–08:00)', () => {
    expect(isWithinDnd('22:00', '08:00', at(23, 30))).toBe(true);
    expect(isWithinDnd('22:00', '08:00', at(2, 0))).toBe(true);
    expect(isWithinDnd('22:00', '08:00', at(8, 0))).toBe(false); // end exclusive
    expect(isWithinDnd('22:00', '08:00', at(12, 0))).toBe(false);
  });

  it('treats malformed times as disabled (returns false)', () => {
    expect(isWithinDnd('bad', '08:00', at(2, 0))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/notificationGate.test.ts`
Expected: FAIL — cannot resolve `./notificationGate` / `isWithinDnd is not a function`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/notificationGate.ts

function toMinutes(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/**
 * True if `now` falls inside the Do-Not-Disturb window [start, end).
 * Supports same-day (start < end) and overnight (start > end) windows.
 * A zero-length or malformed window is treated as disabled (false).
 */
export function isWithinDnd(start: string, end: string, now: Date): boolean {
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s === null || e === null || s === e) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}

/**
 * Best-effort short beep for users who enable notification sound. Uses a brief
 * Web Audio oscillator so we don't ship an audio asset. Silently no-ops if the
 * AudioContext is unavailable or blocked.
 */
export function playNotificationSound(): void {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.05;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.12);
    osc.onended = () => ctx.close();
  } catch {
    /* sound is best-effort; never throw into the poller */
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/notificationGate.test.ts`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add src/lib/notificationGate.ts src/lib/notificationGate.test.ts
git commit -m "feat: DND-window gate and notification sound helper"
```

---

## Task 3: terminalStore session-state map

**Files:**
- Modify: `src/store/terminalStore.ts`
- Test: `src/store/terminalStore.test.ts` (append)

- [ ] **Step 1: Write the failing test (append to the existing file)**

```typescript
// src/store/terminalStore.test.ts — append inside the file
import { describe, it, expect, beforeEach } from 'vitest';
import { useTerminalStore } from './terminalStore';

describe('terminalStore session state', () => {
  beforeEach(() => {
    useTerminalStore.setState({ terminalStates: new Map() });
  });

  it('setTerminalState stores a state', () => {
    useTerminalStore.getState().setTerminalState('a', 'waiting');
    expect(useTerminalStore.getState().terminalStates.get('a')).toBe('waiting');
  });

  it('setTerminalState is a no-op (same map reference) when unchanged', () => {
    useTerminalStore.getState().setTerminalState('a', 'busy');
    const before = useTerminalStore.getState().terminalStates;
    useTerminalStore.getState().setTerminalState('a', 'busy');
    expect(useTerminalStore.getState().terminalStates).toBe(before);
  });

  it('setTerminalState replaces the map when the value changes', () => {
    useTerminalStore.getState().setTerminalState('a', 'busy');
    const before = useTerminalStore.getState().terminalStates;
    useTerminalStore.getState().setTerminalState('a', 'idle');
    expect(useTerminalStore.getState().terminalStates).not.toBe(before);
    expect(useTerminalStore.getState().terminalStates.get('a')).toBe('idle');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/store/terminalStore.test.ts -t "session state"`
Expected: FAIL — `terminalStates` undefined / `setTerminalState is not a function`.

- [ ] **Step 3a: Add the import (top of `src/store/terminalStore.ts`)**

Find line 5:
```typescript
import { markTerminalActive, clearTerminalActivity } from '../lib/terminalActivity';
```
Add immediately after it:
```typescript
import type { SessionState } from '../lib/terminalState';
```

- [ ] **Step 3b: Extend the `TerminalState` interface**

Find (around line 56):
```typescript
  unreadTerminalIds: Set<string>;
```
Add immediately after it:
```typescript
  // Inferred Claude session state per terminal (busy/waiting/idle/stopped).
  // Written only on transitions by the detection poller — never on the
  // streaming hot path — so subscribers re-render only when state changes.
  terminalStates: Map<string, SessionState>;
```

Then find the action declarations block (near `hasUnread: (id: string) => boolean;`, around line 94) and add after it:
```typescript
  setTerminalState: (id: string, state: SessionState) => void;
```

- [ ] **Step 3c: Initialize the map**

Find (around line 115):
```typescript
  unreadTerminalIds: new Set(),
```
Add immediately after it:
```typescript
  terminalStates: new Map(),
```

- [ ] **Step 3d: Implement `setTerminalState`**

Find the `hasUnread` implementation (around line 417):
```typescript
  hasUnread: (id) => {
    return get().unreadTerminalIds.has(id);
  },
```
Add immediately after it:
```typescript

  setTerminalState: (id, state) => {
    // Short-circuit before set() so unchanged states cause zero re-renders.
    if (get().terminalStates.get(id) === state) return;
    set((s) => {
      const next = new Map(s.terminalStates);
      next.set(id, state);
      return { terminalStates: next };
    });
  },
```

- [ ] **Step 3e: Clean up on close**

Find in `closeTerminal` (around line 258):
```typescript
      const newGitCache = new Map(state.gitInfoCache);
      newGitCache.delete(id);
```
Add immediately after it:
```typescript
      const newStates = new Map(state.terminalStates);
      newStates.delete(id);
      if (childId) newStates.delete(childId);
```
Then find the return object in the same function (around line 270) and add `terminalStates: newStates,` after the `unreadTerminalIds: newUnread,` line:
```typescript
      return {
        terminals: newTerminals,
        unreadTerminalIds: newUnread,
        terminalStates: newStates,
        gitInfoCache: newGitCache,
        scriptChildren: newChildren,
        activeTerminalId: state.activeTerminalId === id
          ? (remainingIds[0] || null)
          : state.activeTerminalId,
      };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/store/terminalStore.test.ts -t "session state"`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add src/store/terminalStore.ts src/store/terminalStore.test.ts
git commit -m "feat: track per-terminal session state in terminalStore"
```

---

## Task 4: Window-focus hook

**Files:**
- Create: `src/hooks/useWindowFocused.ts`

No unit test — this is a thin Tauri event binding verified via the manual check in Task 9.

- [ ] **Step 1: Write the implementation**

```typescript
// src/hooks/useWindowFocused.ts
// Tracks whether the app window currently has focus, used by the session-state
// notification rule to suppress alerts for a session the user is looking at.

import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

export function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(true);

  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;

    win.isFocused().then(setFocused).catch(() => { /* default true */ });
    win
      .onFocusChanged(({ payload }) => setFocused(payload))
      .then((fn) => { unlisten = fn; })
      .catch(() => { /* ignore */ });

    return () => { unlisten?.(); };
  }, []);

  return focused;
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS (no errors). If `getCurrentWindow` is not found, confirm the import path against the installed `@tauri-apps/api` version — in Tauri 2 it is `@tauri-apps/api/window`.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useWindowFocused.ts
git commit -m "feat: useWindowFocused hook for notification suppression"
```

---

## Task 5: Shared StateDot component

**Files:**
- Create: `src/components/StateDot.tsx`

Reduce-motion is handled globally by CSS (`:root[data-reduce-motion="true"]`), so the
pulse class `ct-working-dot` auto-disables — no prop needed.

- [ ] **Step 1: Write the implementation**

```tsx
// src/components/StateDot.tsx
import type { SessionState } from '../lib/terminalState';

const DOT: Record<SessionState, { cls: string; pulse: boolean; title: string }> = {
  busy:    { cls: 'bg-success',          pulse: true,  title: 'Claude is working…' },
  waiting: { cls: 'bg-amber-400',        pulse: true,  title: 'Claude needs your input' },
  idle:    { cls: 'bg-text-tertiary/40', pulse: false, title: 'Idle' },
  stopped: { cls: 'bg-text-tertiary',    pulse: false, title: 'Stopped' },
};

export function StateDot({ state, size = 8 }: { state: SessionState; size?: number }) {
  const d = DOT[state];
  return (
    <span
      className={`rounded-full flex-shrink-0 ${d.cls} ${d.pulse ? 'ct-working-dot' : ''}`}
      style={{ width: size, height: size }}
      title={d.title}
    />
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS. (If `bg-amber-400` is not recognized by the Tailwind config, substitute the project's amber token; verify by grepping `amber` in `src/` — `TerminalTabs.tsx` already uses `text-amber`-style tokens via the changelog's accent set.)

- [ ] **Step 3: Commit**

```bash
git add src/components/StateDot.tsx
git commit -m "feat: shared StateDot component for session state"
```

---

## Task 6: Detection poller hook

**Files:**
- Create: `src/hooks/useSessionStateDetection.ts`

This hook owns the xterm buffer read (impure, xterm-specific) and the
transition→notification logic. The pure decision lives in `classifySettled`
(Task 1) and `isWithinDnd` (Task 2), already tested.

- [ ] **Step 1: Write the implementation**

```typescript
// src/hooks/useSessionStateDetection.ts
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
          const dnd = isWithinDnd(app.dndStart, app.dndEnd, new Date());
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
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS. Common fixes: ensure `Terminal` is imported as a type from `@xterm/xterm`; confirm `app.dndStart`, `app.dndEnd`, `app.notificationSoundEnabled` exist on the app store (they do — see `src/store/appStore.ts`).

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useSessionStateDetection.ts
git commit -m "feat: session-state detection poller with attention notifications"
```

---

## Task 7: Mount the poller

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add the import**

Find (around line 34):
```typescript
import { useNotification } from './hooks/useNotification';
```
Add immediately after it:
```typescript
import { useSessionStateDetection } from './hooks/useSessionStateDetection';
```

- [ ] **Step 2: Call the hook**

Find (around line 110):
```typescript
  useKeyboardShortcuts();
```
Add immediately after it:
```typescript
  useSessionStateDetection();
```

- [ ] **Step 3: Type-check and build**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "feat: mount session-state detection poller in App"
```

---

## Task 8: Tab indicator uses StateDot

**Files:**
- Modify: `src/components/TerminalTabs.tsx`

Replaces the binary time-based working dot (`isWorking`) with the four-state
`StateDot`. The unread dot (blue) is kept as-is.

- [ ] **Step 1: Add imports**

Find (around line 17):
```typescript
import { getLastOutputAt } from '../lib/terminalActivity';
```
Add immediately after it:
```typescript
import { StateDot } from './StateDot';
import type { SessionState } from '../lib/terminalState';
```

- [ ] **Step 2: Subscribe to the state map**

Find (line 28):
```typescript
  const { terminals, activeTerminalId, setActiveTerminal, closeTerminal, unreadTerminalIds, gitInfoCache, reorderTerminals, scriptChildren, closeScript } = useTerminalStore();
```
Add a separate selector immediately after it (a focused selector re-renders the
tab strip only when the state map changes):
```typescript
  const terminalStates = useTerminalStore((s) => s.terminalStates);
```

- [ ] **Step 3: Replace the per-tab dot logic**

Find (around lines 217–218):
```typescript
              const lastOutputAt = getLastOutputAt(terminal.id);
              const isWorking = lastOutputAt != null && now - lastOutputAt < 2000;
```
Replace with:
```typescript
              const lastOutputAt = getLastOutputAt(terminal.id);
              const liveBusy = lastOutputAt != null && now - lastOutputAt < 2000;
              // Prefer the poller's classified state; fall back to the live
              // activity timer so the dot lights up instantly on first output
              // before the first poll tick lands.
              const sessionState: SessionState =
                terminalStates.get(terminal.id) ?? (liveBusy ? 'busy' : 'idle');
              const isWorking = sessionState === 'busy';
```

- [ ] **Step 4: Render StateDot for non-idle states**

Find the working-dot block (around lines 257–262):
```tsx
                  {isWorking && (
                    <div
                      className="ct-working-dot w-2 h-2 rounded-full bg-success flex-shrink-0 text-success"
                      title="Claude is working&hellip;"
                    />
                  )}
```
Replace with:
```tsx
                  {sessionState !== 'idle' && (
                    <StateDot state={sessionState} />
                  )}
```

(The `ct-working-tab` class on line 245 stays as-is — it keys off `isWorking`,
which now means `sessionState === 'busy'`.)

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS. If `now` becomes unused after this change, leave it — it is still used by `useNowTick()` to drive the 500ms re-render; do not remove the `useNowTick` call.

- [ ] **Step 6: Commit**

```bash
git add src/components/TerminalTabs.tsx
git commit -m "feat: four-state session dot on terminal tabs"
```

---

## Task 9: Agent View (upgrade Recent Terminals dropdown)

**Files:**
- Modify: `src/components/titlebar/RecentTerminalsMenu.tsx`

Adds: a state pill per row, waiting-first sort, and an amber count badge on the
Layers icon when any session is waiting.

- [ ] **Step 1: Add imports**

Find (line 4):
```typescript
import { useAppStore } from '../../store/appStore';
```
Add immediately after it:
```typescript
import { StateDot } from '../StateDot';
import type { SessionState } from '../../lib/terminalState';

const STATE_ORDER: Record<SessionState, number> = { waiting: 0, busy: 1, idle: 2, stopped: 3 };
const STATE_LABEL: Record<SessionState, string> = {
  waiting: 'Waiting', busy: 'Working', idle: 'Idle', stopped: 'Stopped',
};
```

- [ ] **Step 2: Read the state map and compute the waiting count**

Find (line 16):
```typescript
  const { terminals, activeTerminalId, setActiveTerminal, gitInfoCache } = useTerminalStore();
```
Add immediately after it:
```typescript
  const terminalStates = useTerminalStore((s) => s.terminalStates);
```

- [ ] **Step 3: Sort items waiting-first and expose count**

Replace the `items` memo (lines 19–24):
```typescript
  const items = useMemo(() => {
    return Array.from(terminals.values())
      .filter((t) => !t.scriptParentId && !t.isShellTerminal)
      .sort((a, b) => (a.config.created_at < b.config.created_at ? 1 : -1))
      .slice(0, 20);
  }, [terminals]);
```
with:
```typescript
  const items = useMemo(() => {
    const list = Array.from(terminals.values())
      .filter((t) => !t.scriptParentId && !t.isShellTerminal);
    return list
      .sort((a, b) => {
        const sa = STATE_ORDER[terminalStates.get(a.config.id) ?? 'idle'];
        const sb = STATE_ORDER[terminalStates.get(b.config.id) ?? 'idle'];
        if (sa !== sb) return sa - sb;                       // waiting first
        return a.config.created_at < b.config.created_at ? 1 : -1; // then recent
      })
      .slice(0, 20);
  }, [terminals, terminalStates]);

  const waitingCount = useMemo(
    () =>
      Array.from(terminals.values()).filter(
        (t) =>
          !t.scriptParentId &&
          !t.isShellTerminal &&
          terminalStates.get(t.config.id) === 'waiting',
      ).length,
    [terminals, terminalStates],
  );
```

- [ ] **Step 4: Add the count badge to the toolbar button**

Find the button's icon block (lines 52–53):
```tsx
        <Layers size={13} strokeWidth={2} className="text-pink-400" />
        <ChevronDown size={10} strokeWidth={2} className="text-text-tertiary" />
```
Replace with:
```tsx
        <span className="relative inline-flex">
          <Layers size={13} strokeWidth={2} className="text-pink-400" />
          {waitingCount > 0 && (
            <span
              className="absolute -top-1.5 -right-1.5 min-w-[14px] h-[14px] px-[3px] rounded-full bg-amber-400 text-black text-[9px] font-bold leading-[14px] text-center"
              title={`${waitingCount} session(s) waiting for input`}
            >
              {waitingCount}
            </span>
          )}
        </span>
        <ChevronDown size={10} strokeWidth={2} className="text-text-tertiary" />
```

- [ ] **Step 5: Show the state in each row**

Find the row's status dot (line 76):
```tsx
                  <span className={`mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_DOT[t.config.status]}`} />
```
Replace with:
```tsx
                  <span className="mt-1.5">
                    <StateDot state={terminalStates.get(t.config.id) ?? 'idle'} size={6} />
                  </span>
```
Then find the terminal name span (lines 79–81) and add a state-label pill after the closing `</span>` of the name, inside the `flex items-center gap-1.5` row:
```tsx
                      <span className="text-[12px] font-medium truncate text-text-primary">
                        {t.config.nickname || t.config.label}
                      </span>
                      <span className="text-[9px] text-text-tertiary flex-shrink-0">
                        {STATE_LABEL[terminalStates.get(t.config.id) ?? 'idle']}
                      </span>
```

- [ ] **Step 6: Remove the now-unused STATUS_DOT constant**

Find and delete (lines 6–11):
```typescript
const STATUS_DOT: Record<string, string> = {
  Running: 'bg-success',
  Idle: 'bg-warning',
  Error: 'bg-error',
  Stopped: 'bg-text-tertiary',
};
```

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS (no unused-symbol errors for `STATUS_DOT`).

- [ ] **Step 8: Commit**

```bash
git add src/components/titlebar/RecentTerminalsMenu.tsx
git commit -m "feat: Agent View — state pills, waiting-first sort, count badge"
```

---

## Task 10: Calibration + end-to-end verification

This task has no code of its own — it validates the heuristics against the real
Claude Code build and confirms the feature works end to end.

- [ ] **Step 1: Run the full unit suite**

Run: `npx vitest run`
Expected: PASS, including the new `terminalState`, `notificationGate`, and `terminalStore` tests.

- [ ] **Step 2: Type-check the whole project**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Launch the app**

Run: `npm run tauri dev`

- [ ] **Step 4: Calibrate the classifier against the live build**

In a Claude terminal, trigger each prompt and confirm the tab dot and Agent View:
- Ask Claude to do something needing a permission decision (e.g. run a tool that prompts) → tab dot turns **amber**, Agent View row shows **Waiting** and sorts to top, icon badge shows the count.
- Let a normal turn finish (sits at the input box) → dot goes faint, row shows **Idle** (no notification).
- While Claude streams → dot is **green** (Busy).
- Close/exit Claude → row shows **Stopped**.

If a real prompt is misclassified, capture the offending bottom-rows text and adjust `WAITING_PATTERNS` / `IDLE_MARKERS` in `src/lib/terminalState.ts`, add a fixture to `terminalState.test.ts` reproducing it, and re-run `npx vitest run src/lib/terminalState.test.ts`.

- [ ] **Step 5: Verify the notification rule**

- Background the app (or switch to another tab) and trigger a waiting prompt → exactly one native notification fires.
- With the waiting session as the active tab **and** the window focused → no notification.
- Set a DND window covering "now" in Settings → Notifications → no notification fires while waiting.

- [ ] **Step 6: Commit any calibration changes**

```bash
git add src/lib/terminalState.ts src/lib/terminalState.test.ts
git commit -m "test: calibrate session-state patterns against live Claude build"
```

---

## Self-review notes (author check — already applied)

- **Spec coverage:** 4-state model (Tasks 1, 6); xterm-buffer detection (Tasks 1, 6); store with no-op-on-unchanged (Task 3); tab dots (Task 8); Agent View on Recent Terminals with waiting-first sort + count badge (Task 9); attention-only notification with focus suppression + dedup + DND (Tasks 2, 6); no idle ping (Task 6 only notifies on `waiting`); plain-shell exclusion (Task 6); reduce-motion via global CSS (Task 5); tests for classifier, gate, store (Tasks 1–3). All spec sections map to a task.
- **Spec discrepancy resolved:** the spec said "reuse existing DND/sound gating" — none existed, so Task 2 builds it. The existing finish-notification path in `App.tsx` is intentionally left unchanged (out of scope).
- **Type consistency:** `SessionState` is defined once in `terminalState.ts` and imported everywhere; `classifySettled`, `setTerminalState`, `isWithinDnd`, `playNotificationSound`, `StateDot`, `useWindowFocused`, `useSessionStateDetection` names match across all tasks.
- **Open verification (Task 9 Step 4 / Task 6):** confirm inactive-tab `TerminalView` keeps its xterm mounted; if any path disposes it the poller already falls back to last-known state.
