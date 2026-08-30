# Session Card: Branch Chip and Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the current git branch on each Sessions-sidebar card and let users rename a card via double-click or a "Rename..." context-menu entry.

**Architecture:** All UI work lives in `src/components/SessionCards.tsx`. The only pure logic worth testing (the rename-commit decision) is extracted to a new `src/lib/renameTab.ts` with a colocated vitest file, matching how other tab/session helpers in this repo are organized (`src/lib/closeTabActions.ts`, `src/lib/pinnedTabOrder.ts`). Backend, IPC, and store surfaces stay unchanged - we reuse `useTerminalStore.updateNickname` (which already wraps `update_terminal_nickname`) and `useTerminalStore.gitInfoCache` (already populated by `fetchGitInfo` at terminal creation).

**Tech Stack:** React 18 + TypeScript, Zustand, Framer Motion (`Reorder`), Tailwind, lucide-react, vitest (jsdom), no React Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-30-session-card-branch-and-rename-design.md`

---

## File Map

- Create: `src/lib/renameTab.ts` - pure `resolveRenameCommit` helper.
- Create: `src/lib/renameTab.test.ts` - vitest coverage of the helper.
- Modify: `src/components/SessionCards.tsx` - branch chip, inline rename input, "Rename..." menu item, drag disable while renaming.

Nothing else changes.

---

## Task 1: Pure rename-commit helper (TDD)

**Files:**
- Create: `src/lib/renameTab.ts`
- Test: `src/lib/renameTab.test.ts`

The rename input needs a decision: given the input's current text and the terminal's persisted nickname, should we call `updateNickname`, and with what value? Cases:

- User pressed Enter without changing anything → no-op.
- User cleared the input (or typed only whitespace) on a terminal that had a nickname → persist `""` so the display falls back to the profile `label`.
- User cleared the input on a terminal that already had no nickname → no-op.
- User typed a new non-empty value → persist the trimmed value.

- [ ] **Step 1.1: Write the failing test**

Create `src/lib/renameTab.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveRenameCommit } from './renameTab';

describe('resolveRenameCommit', () => {
  it('no-op when the trimmed input equals the current nickname', () => {
    expect(resolveRenameCommit({ currentNickname: 'Custom', raw: 'Custom' })).toEqual({
      shouldCommit: false,
      nickname: '',
    });
  });

  it('no-op when leading/trailing whitespace makes the input equal the current nickname', () => {
    // The input reflects what the user typed, but a stray space shouldn't
    // force a redundant IPC round-trip.
    expect(resolveRenameCommit({ currentNickname: 'Custom', raw: '  Custom  ' })).toEqual({
      shouldCommit: false,
      nickname: '',
    });
  });

  it('no-op when the terminal has no nickname and the user submits an empty input', () => {
    // Clearing something already cleared shouldn't send `update_terminal_nickname("")`.
    expect(resolveRenameCommit({ currentNickname: null, raw: '' })).toEqual({
      shouldCommit: false,
      nickname: '',
    });
    expect(resolveRenameCommit({ currentNickname: null, raw: '   ' })).toEqual({
      shouldCommit: false,
      nickname: '',
    });
  });

  it('commits an empty string when clearing an existing nickname', () => {
    // Persisting "" is how the backend signals "fall back to the profile label"
    // for the sidebar name (`name = nickname || label`).
    expect(resolveRenameCommit({ currentNickname: 'Custom', raw: '' })).toEqual({
      shouldCommit: true,
      nickname: '',
    });
  });

  it('commits the trimmed value when the user typed a new name', () => {
    expect(resolveRenameCommit({ currentNickname: null, raw: 'Renamed' })).toEqual({
      shouldCommit: true,
      nickname: 'Renamed',
    });
    expect(resolveRenameCommit({ currentNickname: 'Old', raw: '  New  ' })).toEqual({
      shouldCommit: true,
      nickname: 'New',
    });
  });
});
```

- [ ] **Step 1.2: Run the test and watch it fail**

Run: `npm run test:run -- src/lib/renameTab.test.ts`
Expected: FAIL - "Cannot find module './renameTab'".

- [ ] **Step 1.3: Write the minimal implementation**

Create `src/lib/renameTab.ts`:

```ts
/**
 * Decides whether the sidebar Session card's rename input should persist a
 * new nickname when the user commits (Enter / blur), and what value to persist.
 * Extracted here so the component just wires event handlers - the decision
 * logic is trivially unit-testable and free of Zustand / IPC coupling.
 *
 * Rules:
 *   - Trim the raw input.
 *   - If the trimmed value equals the currently-persisted nickname (with null
 *     treated as ""), it's a no-op - the user pressed Enter without changing
 *     anything, or added incidental whitespace.
 *   - Otherwise commit the trimmed value. Committing "" clears the nickname
 *     so `name = nickname || label` falls back to the profile-derived label.
 */
export interface RenameInput {
  currentNickname: string | null;
  raw: string;
}

export interface RenameCommit {
  shouldCommit: boolean;
  /** Value to pass to `updateNickname`. Meaningful only when
   *  `shouldCommit === true`; otherwise it's an empty placeholder. */
  nickname: string;
}

export function resolveRenameCommit({ currentNickname, raw }: RenameInput): RenameCommit {
  const trimmed = raw.trim();
  const currentNorm = currentNickname ?? '';
  if (trimmed === currentNorm) {
    return { shouldCommit: false, nickname: '' };
  }
  return { shouldCommit: true, nickname: trimmed };
}
```

- [ ] **Step 1.4: Run the test and watch it pass**

Run: `npm run test:run -- src/lib/renameTab.test.ts`
Expected: PASS - 5 tests green.

- [ ] **Step 1.5: Commit**

```bash
git add src/lib/renameTab.ts src/lib/renameTab.test.ts
git commit -m "feat(sidebar): add resolveRenameCommit helper for session card rename"
```

---

## Task 2: Branch chip on the session card

**Files:**
- Modify: `src/components/SessionCards.tsx`

The `gitInfoCache` selector is already populated for every terminal (see `terminalStore.ts:712 fetchGitInfo`, called from `createTerminal` and `adoptTerminal`). We just subscribe and render the chip on the second row of the card. Icon choice matches the existing pattern in `src/components/titlebar/SessionWidget.tsx:143-148` (`GitFork` for worktrees, `GitBranch` for main).

- [ ] **Step 2.1: Add the imports**

In `src/components/SessionCards.tsx`, change the lucide-react import on line 3 to include `GitBranch`, `GitFork`, and `Pencil` (the pencil is used in Task 4 but keeping the import block coherent avoids two edits to the same line):

```tsx
import { X, Copy, Grid3X3, AppWindow, Pin, PinOff, SplitSquareHorizontal, GitBranch, GitFork, Pencil } from 'lucide-react';
```

- [ ] **Step 2.2: Subscribe to gitInfoCache**

In the `SessionCards` component body, right after `const unreadTerminalIds = useTerminalStore((s) => s.unreadTerminalIds);` (line 64), add:

```tsx
  const gitInfoCache = useTerminalStore((s) => s.gitInfoCache);
```

- [ ] **Step 2.3: Read per-card git info inside the map**

Inside the `orderedIds.map((id) => { ... })` block, near where `dir` and `cost` are computed (around line 201-203), add:

```tsx
        const gitInfo = gitInfoCache.get(id);
```

- [ ] **Step 2.4: Render the chip on the second row**

Replace the second-row `<div>` at lines 293-296:

```tsx
            <div className="mt-1 flex items-center gap-2 text-[11px] text-text-tertiary">
              {dir && <span className="truncate">{dir}</span>}
              {cost && <span className="ml-auto text-emerald-500 font-medium tabular-nums">{cost}</span>}
            </div>
```

With:

```tsx
            <div className="mt-1 flex items-center gap-2 text-[11px] text-text-tertiary">
              {dir && <span className="truncate">{dir}</span>}
              {gitInfo?.is_git_repo && gitInfo.current_branch && (
                <span
                  className="flex items-center gap-0.5 max-w-[100px] flex-shrink-0"
                  title={gitInfo.is_worktree ? `Worktree · ${gitInfo.current_branch}` : gitInfo.current_branch}
                >
                  {gitInfo.is_worktree
                    ? <GitFork size={10} strokeWidth={1.75} className="flex-shrink-0" />
                    : <GitBranch size={10} strokeWidth={1.75} className="flex-shrink-0" />}
                  <span className="truncate">{gitInfo.current_branch}</span>
                </span>
              )}
              {cost && <span className="ml-auto text-emerald-500 font-medium tabular-nums">{cost}</span>}
            </div>
```

- [ ] **Step 2.5: Verify types + tests still pass**

Run: `npm run build`
Expected: `tsc && vite build` finishes with no errors.

Run: `npm run test:run`
Expected: all existing tests remain green, plus the 5 new ones from Task 1.

- [ ] **Step 2.6: Commit**

```bash
git add src/components/SessionCards.tsx
git commit -m "feat(sidebar): show current git branch on session cards"
```

---

## Task 3: Inline rename via double-click

**Files:**
- Modify: `src/components/SessionCards.tsx`

Adds:
- a local `renamingId` state (only one card can be in edit mode at a time),
- a small `RenameInput` subcomponent (in the same file - it's specific to this card),
- a subscription to `updateNickname` from the terminal store,
- a `drag={...}` prop on `Reorder.Item` so drag-reorder doesn't fight the input.

- [ ] **Step 3.1: Extend the React import**

Line 1 of `src/components/SessionCards.tsx` currently reads:

```tsx
import { useEffect, useMemo, useState } from 'react';
```

Change to:

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
```

- [ ] **Step 3.2: Import the helper and add store selectors**

Add near the other `../lib/...` imports:

```tsx
import { resolveRenameCommit } from '../lib/renameTab';
```

In the component body, near the other `useTerminalStore` selectors, add:

```tsx
  const updateNickname = useTerminalStore((s) => s.updateNickname);
```

Below the existing `useState<CardContextMenuState | null>` line (~72), add:

```tsx
  const [renamingId, setRenamingId] = useState<string | null>(null);
```

- [ ] **Step 3.3: Add a commitRename helper inside the component**

Right below the `duplicate`, `openInNewWindow`, `splitWithActive` helpers, add:

```tsx
  const commitRename = (id: string, current: string | null, raw: string) => {
    const { shouldCommit, nickname } = resolveRenameCommit({ currentNickname: current, raw });
    if (shouldCommit) {
      updateNickname(id, nickname).catch((err) => {
        toast.error('Rename failed', 'Could not save the new name.');
        reportInvokeFailure('update_terminal_nickname', err);
      });
    }
    setRenamingId(null);
  };
```

- [ ] **Step 3.4: Add the RenameInput subcomponent**

At the bottom of the file, next to the existing `CardMenuItem` component, add:

```tsx
interface RenameInputProps {
  initial: string;
  onCommit: (raw: string) => void;
  onCancel: () => void;
}

/**
 * Inline text input used to rename a session card. Mounted only while the
 * card is in edit mode. Handles focus/select on mount, Enter to commit,
 * Escape to cancel, and blur-to-commit - with a `doneRef` guard so Escape
 * (which unmounts the input and therefore fires blur) doesn't accidentally
 * fire a second commit after cancel.
 *
 * All mouse events are stopPropagation'd so clicking inside the input
 * doesn't also fire the card's `setActiveTerminal`, drag-reorder, or
 * right-click menu handlers on the parent Reorder.Item.
 */
function RenameInput({ initial, onCommit, onCancel }: RenameInputProps) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  const doneRef = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = (kind: 'commit' | 'cancel') => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (kind === 'commit') onCommit(value);
    else onCancel();
  };

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); finish('commit'); }
        else if (e.key === 'Escape') { e.preventDefault(); finish('cancel'); }
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onBlur={() => finish('commit')}
      aria-label="Rename session"
      className="text-[13px] font-medium text-text-primary bg-fill-active outline-none rounded px-1 py-0 min-w-0 flex-1 ring-1 ring-accent-primary/40"
    />
  );
}
```

- [ ] **Step 3.5: Swap the name span for the input when editing**

The current name span at ~line 235 reads:

```tsx
              <span className="text-[13px] font-medium text-text-primary truncate">{name}</span>
```

Replace with:

```tsx
              {renamingId === id ? (
                <RenameInput
                  initial={name}
                  onCommit={(raw) => commitRename(id, t.config.nickname, raw)}
                  onCancel={() => setRenamingId(null)}
                />
              ) : (
                <span
                  className="text-[13px] font-medium text-text-primary truncate"
                  onDoubleClick={(e) => { e.stopPropagation(); setRenamingId(id); }}
                  title="Double-click to rename"
                >
                  {name}
                </span>
              )}
```

- [ ] **Step 3.6: Disable drag on the card while it is being renamed**

The current `Reorder.Item` opens at ~line 205:

```tsx
          <Reorder.Item
            key={id}
            value={id}
            as="div"
            role="button"
            tabIndex={0}
            aria-selected={active}
            onClick={() => setActiveTerminal(id)}
```

Add `drag={renamingId !== id}` right after `aria-selected={active}`:

```tsx
          <Reorder.Item
            key={id}
            value={id}
            as="div"
            role="button"
            tabIndex={0}
            aria-selected={active}
            drag={renamingId !== id}
            onClick={() => setActiveTerminal(id)}
```

Framer's `Reorder.Item` accepts `drag` as `boolean | "x" | "y"`; passing `false` disables drag for that item only. `true` re-enables the axis inherited from `Reorder.Group axis="y"`.

- [ ] **Step 3.7: Keep click-to-activate quiet while the input is up**

The container's `onClick={() => setActiveTerminal(id)}` will fire when the user clicks inside the input via bubbling - but the input already stops propagation on `onClick`/`onMouseDown`, so no change needed here. Sanity-check by reading the modified handler chain: input stops `mousedown` and `click` → container never sees them → `setActiveTerminal` doesn't fire mid-edit.

- [ ] **Step 3.8: Verify typecheck + tests**

Run: `npm run build`
Expected: no errors.

Run: `npm run test:run`
Expected: everything green.

- [ ] **Step 3.9: Manual smoke - double-click rename**

Run: `npm run tauri dev`

Then in the running app:
1. Start a new Claude Code session (or use an existing one).
2. Double-click the session name in the sidebar card. The name becomes an input with the current name pre-selected.
3. Type a new name and press Enter. The card's name updates.
4. Double-click again, press Escape. The card reverts to the previous name.
5. Double-click, clear the input, press Enter. The card falls back to the profile-derived label.
6. Try to drag-reorder while an input is open - the card should not move; other cards still reorder.

Stop the dev server when done.

- [ ] **Step 3.10: Commit**

```bash
git add src/components/SessionCards.tsx
git commit -m "feat(sidebar): rename session card by double-clicking its name"
```

---

## Task 4: "Rename..." context-menu entry

**Files:**
- Modify: `src/components/SessionCards.tsx`

The context menu already renders (see the `data-context-menu="session-cards"` block, ~line 302). Add "Rename..." as the first item so users who don't guess double-click still find the feature. Shares the same `renamingId` state introduced in Task 3.

- [ ] **Step 4.1: Insert the menu item above "Pin"**

Inside the `<div role="menu" ...>` block, the current first item is:

```tsx
          <CardMenuItem
            icon={ctxPinned ? <PinOff size={13} strokeWidth={1.75} /> : <Pin size={13} strokeWidth={1.75} />}
            label={ctxPinned ? 'Unpin' : 'Pin'}
            onClick={() => { setContextMenu(null); toggleTabPin(ctxId); }}
          />
```

Insert this block above it:

```tsx
          <CardMenuItem
            icon={<Pencil size={13} strokeWidth={1.75} />}
            label="Rename..."
            onClick={() => { setContextMenu(null); setRenamingId(ctxId); }}
          />
          <div className="my-1 border-t border-seam" />
```

The trailing divider visually groups "Rename..." with the naming action and keeps the existing Pin / Split / Open-in-Window group intact.

- [ ] **Step 4.2: Verify typecheck + tests**

Run: `npm run build`
Expected: no errors.

Run: `npm run test:run`
Expected: everything green.

- [ ] **Step 4.3: Manual smoke - context menu rename**

Run: `npm run tauri dev`

Then in the running app:
1. Right-click a session card. The context menu opens with "Rename..." as the first entry.
2. Click "Rename...". The name span turns into an input focused and pre-selected.
3. Type a new name, press Enter. Card renames.
4. Right-click, "Rename...", press Escape. Card reverts.
5. Right-click a different card while the input on another card is open. The input on the first card should commit-on-blur before the menu opens on the second one.

Stop the dev server when done.

- [ ] **Step 4.4: Commit**

```bash
git add src/components/SessionCards.tsx
git commit -m "feat(sidebar): add 'Rename...' entry to session card context menu"
```

---

## Task 5: Full verification pass

**Files:** none (verification only)

- [ ] **Step 5.1: Run the full test suite**

Run: `npm run test:run`
Expected: all green.

- [ ] **Step 5.2: Run the full build**

Run: `npm run build`
Expected: `tsc && vite build` finishes with no errors and no warnings that weren't already there on `master`.

- [ ] **Step 5.3: End-to-end app smoke**

Run: `npm run tauri dev`

Verify all of the following in the running app:

1. **Branch chip - clean state.** Open a session in a repo that has git and a branch. The card shows a `GitBranch` icon + branch name between the directory and the cost.
2. **Branch chip - worktree.** Open a session in a git worktree (e.g. one of the `.worktrees/` directories in this repo, or a fresh `git worktree add`). Icon should be `GitFork`.
3. **Branch chip - non-repo.** Open a shell session in a plain, non-git directory (e.g. `%USERPROFILE%\Documents`). Chip is absent, card layout stays clean.
4. **Rename via double-click.** As in Task 3.9.
5. **Rename via context menu.** As in Task 4.3.
6. **Persistence.** Rename a session, quit the app (menu → Quit), reopen. The nickname persists.
7. **Drag-reorder still works** on cards not being renamed.
8. **Pin/Unpin, Duplicate, Add to Grid, Open in New Window, Close** menu items still work.

Stop the dev server when done.

- [ ] **Step 5.4: Final commit / cleanup**

If any polish tweaks came out of the manual pass, commit them here. Otherwise this task adds no commit.

---

## Self-Review Notes

- **Spec coverage:** every requirement from the design doc (branch chip placement + icon rules, double-click trigger, context-menu trigger, drag disabled while editing, empty submit clears nickname, no backend changes) is addressed by a task and step.
- **Placeholder scan:** no TBDs, no "add appropriate error handling", every code step includes real code.
- **Type consistency:** `resolveRenameCommit` signature is identical in Task 1's implementation and Task 3's call site. `RenameInput` prop names (`initial`, `onCommit`, `onCancel`) are consistent between Steps 3.4 and 3.5. `renamingId` state is introduced once and reused in Task 4.
