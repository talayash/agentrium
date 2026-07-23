# UI Polish v2 — Primitives + Consistency Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship four new `ui/` primitives (`ListRow`, `PanelHeader`, `ProgressStripe`, `EmptyState`), migrate the panels/modals/dropdowns in the spec onto them, add a status-bar notification-unread dot + optional global progress stripe, and add a "just-finished" tab flash — all as a single-release polish pass.

**Architecture:** Primitive-first. Add four small React components under `src/components/ui/`; extract the only branching logic (`ProgressStripe`) to `src/lib/progressStripe.ts` for unit testing per the repo's existing style (pure helpers unit-tested; visual components verified in the dev app). Then walk each listed surface and replace its ad-hoc row/header/empty markup with the new primitives, preserving all behavior.

**Tech Stack:** React 18 + TypeScript, Tailwind CSS (with the existing `--elevation-*`, accent, and text tokens from `src/index.css`), Framer Motion (already wired via `src/lib/motionTokens.ts`), Vitest for pure-helper tests. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-13-ui-polish-primitives-design.md`.

---

## Prep

- [ ] **Prep Step 1: Confirm baseline is green**

Run:
```bash
cd /c/Users/talay/claude-terminal
npx tsc --noEmit
npm run test:run
```
Expected: type-check clean, all vitest suites pass. If either fails, stop and surface — the plan assumes a clean baseline.

- [ ] **Prep Step 2: Read the spec**

Read `docs/superpowers/specs/2026-07-13-ui-polish-primitives-design.md` end-to-end. The plan below implements every section of it. Do not deviate from the visual tokens spelled out there (heights, colors, motions).

---

## Task 1: `progressStripe` helper + tests

**Files:**
- Create: `src/lib/progressStripe.ts`
- Create: `src/lib/progressStripe.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/progressStripe.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeStripeStyle } from './progressStripe';

describe('computeStripeStyle', () => {
  it('returns indeterminate mode when value is undefined', () => {
    const s = computeStripeStyle(undefined);
    expect(s.mode).toBe('indeterminate');
    expect(s.width).toBeUndefined();
  });

  it('returns determinate mode with clamped width when value is provided', () => {
    expect(computeStripeStyle(0.5)).toEqual({ mode: 'determinate', width: '50%' });
    expect(computeStripeStyle(0)).toEqual({ mode: 'determinate', width: '0%' });
    expect(computeStripeStyle(1)).toEqual({ mode: 'determinate', width: '100%' });
  });

  it('clamps out-of-range values', () => {
    expect(computeStripeStyle(-0.2)).toEqual({ mode: 'determinate', width: '0%' });
    expect(computeStripeStyle(1.5)).toEqual({ mode: 'determinate', width: '100%' });
  });

  it('treats NaN as indeterminate (defensive)', () => {
    expect(computeStripeStyle(Number.NaN)).toEqual({ mode: 'indeterminate' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run src/lib/progressStripe.test.ts
```
Expected: FAIL — `Cannot find module './progressStripe'`.

- [ ] **Step 3: Implement the helper**

Create `src/lib/progressStripe.ts`:

```ts
export interface StripeStyle {
  mode: 'indeterminate' | 'determinate';
  /** Only set when mode === 'determinate'. e.g. '62%'. */
  width?: string;
}

/**
 * Resolve the visual state for ProgressStripe. Undefined or NaN => indeterminate
 * (animated slide). Numeric input is clamped to [0, 1] and rendered as a
 * percentage. Extracted for unit-testing per the codebase's existing style.
 */
export function computeStripeStyle(value: number | undefined): StripeStyle {
  if (value === undefined || Number.isNaN(value)) return { mode: 'indeterminate' };
  const clamped = Math.max(0, Math.min(1, value));
  return { mode: 'determinate', width: `${Math.round(clamped * 100)}%` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npx vitest run src/lib/progressStripe.test.ts
```
Expected: PASS, 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/progressStripe.ts src/lib/progressStripe.test.ts
git commit -m "feat(ui): progressStripe helper + tests"
```

---

## Task 2: `ProgressStripe` component

**Files:**
- Create: `src/components/ui/ProgressStripe.tsx`
- Modify: `src/index.css` (add `ct-stripe-slide` keyframe)

- [ ] **Step 1: Add the keyframe to `index.css`**

Open `src/index.css`. Find the block that ends with the existing `ct-shimmer` keyframe (search for `@keyframes ct-shimmer`). Add immediately after it:

```css
/* ProgressStripe indeterminate slide (Phase-2 UI polish). Neutralised by the
   global reduce-motion cascade above. */
@keyframes ct-stripe-slide {
  0%   { left: -30%; }
  100% { left: 100%; }
}
```

- [ ] **Step 2: Implement the component**

Create `src/components/ui/ProgressStripe.tsx`:

```tsx
import { computeStripeStyle } from '../../lib/progressStripe';

interface ProgressStripeProps {
  /** 0..1 for determinate; omit for indeterminate. Values outside [0,1] are clamped. */
  value?: number;
  /** Reserves the 2 px row without rendering the bar — prevents layout shift. */
  hidden?: boolean;
  className?: string;
}

/**
 * 2 px indeterminate or determinate progress bar. Sits inside `PanelHeader`
 * or above a status bar. Uses the app's accent color; reduce-motion falls
 * back to a static 30% bar via the global `[data-reduce-motion]` cascade
 * (animation duration collapses to 0.001s).
 */
export function ProgressStripe({ value, hidden = false, className = '' }: ProgressStripeProps) {
  const style = computeStripeStyle(value);
  return (
    <div
      role={value === undefined ? 'progressbar' : 'progressbar'}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={style.mode === 'determinate' ? value : undefined}
      className={`relative h-[2px] overflow-hidden ${className}`}
    >
      {!hidden && style.mode === 'indeterminate' && (
        <span
          aria-hidden
          className="absolute top-0 bottom-0 bg-accent-primary"
          style={{
            width: '30%',
            left: '-30%',
            animation: 'ct-stripe-slide 1400ms cubic-bezier(0.25, 0.1, 0.25, 1) infinite',
          }}
        />
      )}
      {!hidden && style.mode === 'determinate' && (
        <span
          aria-hidden
          className="absolute top-0 bottom-0 left-0 bg-accent-primary"
          style={{ width: style.width }}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

Run:
```bash
npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/index.css src/components/ui/ProgressStripe.tsx
git commit -m "feat(ui): ProgressStripe primitive"
```

---

## Task 3: `EmptyState` component

**Files:**
- Create: `src/components/ui/EmptyState.tsx`

- [ ] **Step 1: Implement the component**

Create `src/components/ui/EmptyState.tsx`:

```tsx
import type { ReactNode } from 'react';

interface EmptyStateProps {
  /** Lucide icon (or any 24 px node). Rendered at ~24 px, muted color. */
  icon?: ReactNode;
  title: string;
  description?: string;
  /** Optional primary action — pass a Button. */
  action?: ReactNode;
  /** Top-align instead of vertical-center. Auto-selected when the parent is short (<200px). */
  compact?: boolean;
  className?: string;
}

/**
 * Centered vertical stack used inside panels/modals when a list is empty.
 * Sober by design: muted icon, one-line title, optional short description,
 * optional primary Button. No illustration, no gradient. Matches IntelliJ
 * "No X yet" tool-window placeholders.
 */
export function EmptyState({ icon, title, description, action, compact = false, className = '' }: EmptyStateProps) {
  return (
    <div
      className={`flex flex-col items-center ${compact ? 'justify-start pt-6' : 'justify-center'} px-6 py-8 gap-2 text-center ${className}`}
    >
      {icon && (
        <div className="w-8 h-8 flex items-center justify-center text-text-tertiary">
          {icon}
        </div>
      )}
      <div className="text-[13px] font-medium text-text-primary">{title}</div>
      {description && (
        <div className="text-[12px] text-text-tertiary max-w-[220px] leading-[1.5]">
          {description}
        </div>
      )}
      {action && <div className="mt-1.5">{action}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

Run:
```bash
npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/EmptyState.tsx
git commit -m "feat(ui): EmptyState primitive"
```

---

## Task 4: `ListRow` component

**Files:**
- Create: `src/components/ui/ListRow.tsx`

- [ ] **Step 1: Implement the component**

Create `src/components/ui/ListRow.tsx`:

```tsx
import { forwardRef } from 'react';
import type { ReactNode, MouseEvent, KeyboardEvent } from 'react';

export type ListRowVariant = 'default' | 'compact';

interface ListRowProps {
  selected?: boolean;
  disabled?: boolean;
  onClick?: (e: MouseEvent<HTMLElement>) => void;
  onContextMenu?: (e: MouseEvent<HTMLElement>) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
  /** Optional leading icon/dot. Rendered before children. */
  leading?: ReactNode;
  /** Optional right-aligned meta slot (kbd chip, count, date). */
  trailing?: ReactNode;
  /** Render as a <button> (default — keyboard-clickable) or a <div> (for
   *  wrapping already-interactive children). */
  as?: 'button' | 'div';
  /** 'default' = 26px; 'compact' = 22px. */
  variant?: ListRowVariant;
  title?: string;
  ariaLabel?: string;
  className?: string;
  children: ReactNode;
}

/**
 * Canonical selectable list item. Selected state gets an accent-blue tint
 * plus a 2px stripe on the left (IntelliJ tool-window selection). Hover state
 * is `bg-white/[0.045]`, consistent across every migrated surface.
 *
 * When `as="button"` (default), the row is keyboard-focusable and inherits
 * the global `:focus-visible` outline from index.css.
 */
export const ListRow = forwardRef<HTMLElement, ListRowProps>(function ListRow(
  {
    selected = false,
    disabled = false,
    onClick,
    onContextMenu,
    onKeyDown,
    leading,
    trailing,
    as = 'button',
    variant = 'default',
    title,
    ariaLabel,
    className = '',
    children,
  },
  ref,
) {
  const height = variant === 'compact' ? 'h-[22px]' : 'h-[26px]';
  const base =
    `relative flex items-center gap-2 w-full px-3 text-left transition-colors ${height}`;
  const state = selected
    ? 'bg-accent-primary/12 text-text-primary'
    : 'text-text-primary hover:bg-white/[0.045]';
  const disabledCls = disabled ? 'opacity-50 cursor-default pointer-events-none' : '';

  const content = (
    <>
      {selected && (
        <span
          aria-hidden
          className="absolute left-0 top-[3px] bottom-[3px] w-[2px] rounded-r-[2px] bg-accent-primary"
        />
      )}
      {leading && <span className="flex-shrink-0 flex items-center">{leading}</span>}
      <span className="flex-1 min-w-0 flex items-center gap-2">{children}</span>
      {trailing && <span className="flex-shrink-0 flex items-center">{trailing}</span>}
    </>
  );

  if (as === 'div') {
    return (
      <div
        ref={ref as React.Ref<HTMLDivElement>}
        role="option"
        aria-selected={selected}
        aria-disabled={disabled || undefined}
        aria-label={ariaLabel}
        title={title}
        onClick={disabled ? undefined : onClick}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
        className={`${base} ${state} ${disabledCls} ${className}`}
      >
        {content}
      </div>
    );
  }

  return (
    <button
      ref={ref as React.Ref<HTMLButtonElement>}
      type="button"
      aria-selected={selected}
      aria-label={ariaLabel}
      disabled={disabled}
      title={title}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
      className={`${base} ${state} ${disabledCls} ${className}`}
    >
      {content}
    </button>
  );
});
```

- [ ] **Step 2: Verify build**

Run:
```bash
npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/ListRow.tsx
git commit -m "feat(ui): ListRow primitive with accent selection stripe"
```

---

## Task 5: `PanelHeader` component

**Files:**
- Create: `src/components/ui/PanelHeader.tsx`

- [ ] **Step 1: Implement the component**

Create `src/components/ui/PanelHeader.tsx`:

```tsx
import type { ReactNode } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { ProgressStripe } from './ProgressStripe';

interface PanelHeaderProps {
  title: ReactNode;
  /** Optional trailing count next to the title, e.g. sessions count. */
  count?: number;
  /** Renders a chevron on the left; when true, the whole header is a click target. */
  collapsible?: boolean;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** Right-slot: usually a small cluster of icon buttons. */
  actions?: ReactNode;
  /** When present, renders a 2px progress bar under the header — shows either
   *  an indeterminate slide or a determinate fill (value 0..1). */
  progress?: { active: boolean; value?: number };
  className?: string;
}

/**
 * 26 px header strip for tool windows. Converges the divergent panel-title
 * styles across the codebase onto one primitive: uppercase 11 px muted title,
 * optional count, optional actions cluster (right), optional 2 px progress
 * stripe below the header row.
 */
export function PanelHeader({
  title,
  count,
  collapsible = false,
  collapsed = false,
  onToggleCollapsed,
  actions,
  progress,
  className = '',
}: PanelHeaderProps) {
  const titleNode = (
    <span className="flex items-center gap-1.5 text-text-secondary text-[11px] font-semibold uppercase tracking-[0.06em]">
      {collapsible && (
        collapsed
          ? <ChevronRight size={11} strokeWidth={2} />
          : <ChevronDown size={11} strokeWidth={2} />
      )}
      {title}
      {typeof count === 'number' && count > 0 && (
        <span className="text-text-tertiary text-[10.5px] tabular-nums normal-case tracking-normal font-normal ml-0.5">
          {count}
        </span>
      )}
    </span>
  );

  return (
    <div className={className}>
      <div className="h-[26px] flex items-center justify-between px-3 bg-elevation-1 border-b border-[var(--ij-divider-soft)]">
        {collapsible ? (
          <button
            onClick={onToggleCollapsed}
            className="flex items-center hover:text-text-primary transition-colors"
            title={collapsed ? 'Expand' : 'Collapse'}
          >
            {titleNode}
          </button>
        ) : (
          titleNode
        )}
        {actions && <div className="flex items-center gap-0.5">{actions}</div>}
      </div>
      {progress?.active && (
        <ProgressStripe value={progress.value} className="-mt-[1px]" />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

Run:
```bash
npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/PanelHeader.tsx
git commit -m "feat(ui): PanelHeader primitive"
```

---

## Task 6: Migrate `SessionsPanel`

**Files:**
- Modify: `src/components/SessionsPanel.tsx`

- [ ] **Step 1: Replace the header block**

Open `src/components/SessionsPanel.tsx`. Add these imports at the top of the file (alongside the existing imports):

```tsx
import { PanelHeader } from './ui/PanelHeader';
import { ListRow } from './ui/ListRow';
import { EmptyState } from './ui/EmptyState';
```

Replace the entire header `<div>` block (currently at ~lines 200–230, from `<div className="flex items-center justify-between h-[26px] px-3 flex-shrink-0">` through its closing `</div>`) with:

```tsx
<PanelHeader
  title="Sessions"
  count={collapsed ? undefined : sessions.length}
  collapsible
  collapsed={collapsed}
  onToggleCollapsed={toggleCollapsed}
  progress={{ active: !collapsed && loading }}
  actions={!collapsed && (
    <button
      onClick={fetchSessions}
      disabled={loading}
      className="w-5 h-5 flex items-center justify-center rounded-[4px] hover:bg-white/[0.06] text-text-tertiary hover:text-text-secondary transition-colors disabled:opacity-40"
      title="Refresh"
    >
      <RefreshCw size={11} className={loading ? 'animate-spin' : ''} strokeWidth={1.75} />
    </button>
  )}
/>
```

- [ ] **Step 2: Replace the empty-list placeholders with EmptyState**

Still in `SessionsPanel.tsx`. Replace the block:

```tsx
{!error && sessions.length === 0 && !loading && (
  <div className="px-3 py-2 text-text-tertiary text-[11px]">
    No saved sessions in this folder yet.
  </div>
)}
```

with:

```tsx
{!error && sessions.length === 0 && !loading && (
  <EmptyState
    icon={<MessageSquare size={20} strokeWidth={1.75} />}
    title="No sessions yet"
    description="Resumable Claude sessions in this folder will appear here."
    compact
  />
)}
```

- [ ] **Step 3: Replace the inner `SessionRow` implementation with `ListRow`**

Still in `SessionsPanel.tsx`. Replace the entire `function SessionRow` body (its rendered `<button>` tree, ~lines 295–334) with a `ListRow`:

```tsx
function SessionRow({ session, active, onOpenInNewTab, onContextMenu }: SessionRowProps) {
  return (
    <ListRow
      selected={active}
      onClick={() => { if (!active) onOpenInNewTab(session); }}
      onContextMenu={(e) => onContextMenu(e, session)}
      title={session.preview || session.id}
      leading={
        <MessageSquare
          size={11}
          strokeWidth={1.75}
          className={`shrink-0 ${active ? 'text-accent-primary' : 'text-text-tertiary'}`}
        />
      }
      trailing={
        <span className="text-[10.5px] text-text-tertiary tabular-nums">
          {formatRelativeTime(session.modified_at)}
        </span>
      }
    >
      <span className={`text-[12px] truncate ${active ? 'text-accent-primary font-medium' : 'text-text-primary'}`}>
        {session.preview || `Session ${session.id.slice(0, 8)}`}
      </span>
    </ListRow>
  );
}
```

- [ ] **Step 4: Verify type-check + build**

Run:
```bash
npx tsc --noEmit
npm run build
```
Expected: both clean.

- [ ] **Step 5: Manual visual check**

Run `npm run tauri dev`. Open a folder that has at least one saved Claude session. Verify:
- Sessions header is 26 px, uppercase muted title with count.
- Refresh spinner still works and a thin progress stripe appears under the header while loading.
- Selected session row has a 2 px accent stripe on the left plus tinted background.
- With a folder that has no sessions, the empty state renders centered with a `MessageSquare` icon.

- [ ] **Step 6: Commit**

```bash
git add src/components/SessionsPanel.tsx
git commit -m "feat(sessions): migrate to PanelHeader + ListRow + EmptyState + progress"
```

---

## Task 7: Migrate `FileTreePanel` and `Sidebar`'s outer header

**Files:**
- Modify: `src/components/FileTreePanel.tsx`
- Modify: `src/components/Sidebar.tsx`

- [ ] **Step 1: Replace the outer Sidebar "PROJECT" header**

Open `src/components/Sidebar.tsx`. At the top imports, add:

```tsx
import { PanelHeader } from './ui/PanelHeader';
```

Replace the header block (currently the `<div className="flex items-center justify-between h-[30px] px-3 ...">` and its children) with:

```tsx
<PanelHeader
  title={<><FolderTree size={12} strokeWidth={1.75} />Project</>}
  actions={
    <Tooltip label="Collapse Sidebar">
      <button
        onClick={toggleSidebarCollapse}
        className="w-6 h-6 flex items-center justify-center rounded-[4px] hover:bg-white/[0.06] text-text-tertiary hover:text-text-secondary transition-colors"
      >
        <ChevronsLeft size={13} strokeWidth={1.75} />
      </button>
    </Tooltip>
  }
/>
```

- [ ] **Step 2: Migrate FileTreePanel header**

Open `src/components/FileTreePanel.tsx`. Locate the panel's header block (the current inline uppercase title + refresh/pin buttons cluster). Add the import:

```tsx
import { PanelHeader } from './ui/PanelHeader';
```

Replace the header block with a `PanelHeader` invocation that preserves the existing title, actions (pin/reveal/refresh), and — if the panel has a loading state — the progress prop. Read the current header for the exact actions cluster; do not drop any buttons.

- [ ] **Step 3: Migrate the file-tree row rendering to `ListRow (compact)`**

In `FileTreePanel.tsx`, locate the row-rendering function (search for the `<button` or `<div` that renders each file/folder). Add the import:

```tsx
import { ListRow } from './ui/ListRow';
```

Replace the row markup with `<ListRow variant="compact" selected={isActive} onClick={...} leading={<icon/>} trailing={...}>{name}</ListRow>`. Preserve all existing click/context/keyboard handlers and the folder-vs-file iconography.

- [ ] **Step 4: Verify type-check + build**

Run:
```bash
npx tsc --noEmit
npm run build
```
Expected: both clean.

- [ ] **Step 5: Manual visual check**

Run `npm run tauri dev`. Open a folder in the Explorer panel. Verify:
- Sidebar's "PROJECT" header is unchanged visually but goes through `PanelHeader`.
- FileTreePanel rows are 22 px, hover fill consistent, selected file has the 2 px stripe.
- All existing behavior (expand folders, click to open, right-click menu) still works.

- [ ] **Step 6: Commit**

```bash
git add src/components/FileTreePanel.tsx src/components/Sidebar.tsx
git commit -m "feat(sidebar): migrate outer header + file tree to PanelHeader + ListRow"
```

---

## Task 8: Migrate `TitleBar` branch dropdown to `ListRow (compact)`

**Files:**
- Modify: `src/components/TitleBar.tsx`

- [ ] **Step 1: Add import**

At the top of `src/components/TitleBar.tsx`, add:

```tsx
import { ListRow } from './ui/ListRow';
```

- [ ] **Step 2: Replace each `<button>` inside the branch dropdown with `ListRow`**

In `TitleBar.tsx`, find the branch-list mapping block (search for `filteredBranches.map((b) =>`). Replace each rendered `<button>` (currently ~lines 262–280) with:

```tsx
<ListRow
  key={b}
  variant="compact"
  selected={b === gitInfo.current_branch}
  disabled={checkoutTarget === b || b === gitInfo.current_branch}
  onClick={() => handleCheckout(b)}
  trailing={
    checkoutTarget === b ? (
      <Loader2 size={11} className="animate-spin text-text-tertiary" />
    ) : b === gitInfo.current_branch ? (
      <Check size={12} className="text-accent-primary" />
    ) : null
  }
>
  <span className="truncate font-mono text-[12px]">{b}</span>
</ListRow>
```

- [ ] **Step 3: Verify type-check + build**

Run:
```bash
npx tsc --noEmit
npm run build
```
Expected: both clean.

- [ ] **Step 4: Manual visual check**

Run `npm run tauri dev`. Open the branch dropdown from the title bar. Verify:
- Current branch row has the 2 px accent stripe on the left.
- Filter input still works.
- Hover / click on a different branch still checks it out.

- [ ] **Step 5: Commit**

```bash
git add src/components/TitleBar.tsx
git commit -m "feat(titlebar): branch dropdown uses ListRow"
```

---

## Task 9: Migrate `SessionWidget` dropdown to `ListRow (compact)`

**Files:**
- Modify: `src/components/titlebar/SessionWidget.tsx`

- [ ] **Step 1: Add import**

Add to the top of `src/components/titlebar/SessionWidget.tsx`:

```tsx
import { ListRow } from '../ui/ListRow';
```

- [ ] **Step 2: Replace each session row inside the dropdown with `ListRow`**

Find the session-list mapping block inside the widget's dropdown. Replace each rendered row (currently a `<button>` or `<div>` with a state dot + name + branch + cwd) with:

```tsx
<ListRow
  key={t.id}
  variant="compact"
  selected={t.id === activeTerminalId}
  onClick={() => onSelect(t.id)}
  leading={<StateDot state={terminalStates.get(t.id) ?? 'idle'} />}
  trailing={t.git_branch && (
    <span className={`text-[11px] font-mono ${t.isWorktree ? 'text-purple-400' : 'text-text-tertiary'} truncate max-w-[80px]`}>
      {t.git_branch}
    </span>
  )}
>
  <span className="truncate text-[12px]">{t.nickname || t.label}</span>
  <span className="text-text-tertiary text-[11px] truncate">{t.cwdBase}</span>
</ListRow>
```

Adjust the property names to match the widget's local variables — do **not** rename them; they're already established.

- [ ] **Step 3: Verify type-check + build**

Run:
```bash
npx tsc --noEmit
npm run build
```
Expected: both clean.

- [ ] **Step 4: Manual visual check**

Run `npm run tauri dev`. Open the session widget dropdown from the titlebar. Verify:
- Active session has the 2 px accent stripe.
- Waiting-count badge in the collapsed widget is unchanged.
- Click switches terminals; footer actions still work.

- [ ] **Step 5: Commit**

```bash
git add src/components/titlebar/SessionWidget.tsx
git commit -m "feat(titlebar): session widget dropdown uses ListRow"
```

---

## Task 10: Migrate `FileChangesPanel` change rows to `ListRow`

**Files:**
- Modify: `src/components/FileChangesPanel.tsx`
- Modify: `src/components/ChangelistSection.tsx` (only the leaf row rendering)

- [ ] **Step 1: Add import to `ChangelistSection.tsx`**

At the top of `src/components/ChangelistSection.tsx`, add:

```tsx
import { ListRow } from './ui/ListRow';
```

- [ ] **Step 2: Replace only the file-change leaf-row markup**

Inside `ChangelistSection.tsx`, find the row that renders each individual file change (typically has status letter + file path + optional selected/staged indicators). **Do not touch** the collapsible section headers, staging buttons, or drag-drop wrappers — they are load-bearing per the spec.

Replace the leaf row's `<div>` or `<button>` with:

```tsx
<ListRow
  variant="compact"
  selected={isExpanded}                 // or isActive, per the existing local flag
  onClick={onToggleExpand}
  leading={<StatusGlyph status={change.status} />}
  trailing={change.staged && <Check size={11} className="text-emerald-400" />}
  title={change.path}
>
  <span className="truncate text-[12px] font-mono">{change.path}</span>
</ListRow>
```

Use whatever the existing local names are for `isExpanded` / `StatusGlyph` — do not introduce new components.

- [ ] **Step 3: Verify type-check + build**

Run:
```bash
npx tsc --noEmit
npm run build
```
Expected: both clean.

- [ ] **Step 4: Manual visual check**

Run `npm run tauri dev` in a git repo with uncommitted changes. Open the Git panel. Verify:
- Selected/expanded file row has the accent stripe.
- Group headers, drag-drop, and staging buttons all still work.
- Right-click still opens the file context menu.

- [ ] **Step 5: Commit**

```bash
git add src/components/ChangelistSection.tsx
git commit -m "feat(git): file-change rows use ListRow"
```

---

## Task 11: Migrate `WorktreeModal` list

**Files:**
- Modify: `src/components/WorktreeModal.tsx`

- [ ] **Step 1: Add imports**

```tsx
import { ListRow } from './ui/ListRow';
import { EmptyState } from './ui/EmptyState';
```

- [ ] **Step 2: Replace the worktree list rows**

Find the mapping over worktrees inside `WorktreeModal.tsx`. Replace each row's markup with:

```tsx
<ListRow
  key={wt.path}
  selected={wt.path === selectedPath}
  onClick={() => setSelectedPath(wt.path)}
  leading={<GitBranch size={12} strokeWidth={1.75} className={wt.is_worktree ? 'text-purple-400' : 'text-text-tertiary'} />}
  trailing={wt.branch && (
    <span className="text-[11px] font-mono text-text-tertiary truncate max-w-[120px]">{wt.branch}</span>
  )}
>
  <span className="truncate text-[12px]">{wt.name}</span>
</ListRow>
```

Match the local property names of the existing worktree data (`name`, `path`, `branch`, `is_worktree`) — do not rename.

- [ ] **Step 3: Add an EmptyState for the "no worktrees" case**

Find the current "No worktrees" text-only fallback. Replace with:

```tsx
<EmptyState
  icon={<GitBranch size={20} strokeWidth={1.75} />}
  title="No worktrees"
  description="Create a worktree to work on multiple branches in parallel."
  compact
/>
```

- [ ] **Step 4: Verify type-check + build**

Run:
```bash
npx tsc --noEmit
npm run build
```
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/WorktreeModal.tsx
git commit -m "feat(worktree): modal uses ListRow + EmptyState"
```

---

## Task 12: Migrate `SnippetsModal` list

**Files:**
- Modify: `src/components/SnippetsModal.tsx`

- [ ] **Step 1: Add imports**

```tsx
import { ListRow } from './ui/ListRow';
import { EmptyState } from './ui/EmptyState';
```

- [ ] **Step 2: Replace snippet row markup with `ListRow`**

Find the mapping over snippets. Replace each row's markup with:

```tsx
<ListRow
  key={s.id}
  selected={s.id === selectedId}
  onClick={() => setSelectedId(s.id)}
  onContextMenu={(e) => openContextMenu(e, s)}
  trailing={<span className="text-[11px] text-text-tertiary tabular-nums">{s.hits ?? ''}</span>}
>
  <span className="truncate text-[12px]">{s.title}</span>
  <span className="text-text-tertiary text-[11px] font-mono truncate">{s.shortcut}</span>
</ListRow>
```

Adjust to match the actual local variable names.

- [ ] **Step 3: Add EmptyState for empty search / no snippets**

Replace whichever placeholder is currently shown when the snippets list is empty (either "no snippets" or "no match") with an `EmptyState` invocation using an appropriate icon (`FileText` or `Search`) and short description.

- [ ] **Step 4: Verify type-check + build**

Run:
```bash
npx tsc --noEmit
npm run build
```
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/SnippetsModal.tsx
git commit -m "feat(snippets): modal uses ListRow + EmptyState"
```

---

## Task 13: Migrate `NewTerminalModal` recent/profile lists

**Files:**
- Modify: `src/components/NewTerminalModal.tsx`

- [ ] **Step 1: Add imports**

```tsx
import { ListRow } from './ui/ListRow';
import { EmptyState } from './ui/EmptyState';
```

- [ ] **Step 2: Replace each list row (recents, profiles, suggestions)**

Locate every list inside the modal that renders items (recent folders, profiles, filtered suggestions). For each `<button>` or `<div>` row, swap to `<ListRow selected={...} onClick={...} leading={<icon/>} trailing={<meta/>}>{name}</ListRow>`. Do not change the click handlers or keyboard-navigation logic.

- [ ] **Step 3: Add EmptyState for empty search results**

Where the modal currently shows "No matches" as a plain paragraph, swap to `EmptyState` with a small `Search` or `FolderOpen` icon and a one-line description.

- [ ] **Step 4: Verify type-check + build**

Run:
```bash
npx tsc --noEmit
npm run build
```
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/NewTerminalModal.tsx
git commit -m "feat(new-terminal): modal uses ListRow + EmptyState"
```

---

## Task 14: Migrate `ProfileModal` profile list

**Files:**
- Modify: `src/components/ProfileModal.tsx`

- [ ] **Step 1: Add imports**

```tsx
import { ListRow } from './ui/ListRow';
import { EmptyState } from './ui/EmptyState';
```

- [ ] **Step 2: Replace profile row markup with `ListRow`**

Locate the profile list mapping. Replace each row with a `ListRow` (default variant) including the profile name (children), color dot (leading), and any right-side meta (trailing). Preserve onClick / onContextMenu behavior.

- [ ] **Step 3: Add EmptyState when no profiles exist**

Replace the "No profiles yet" placeholder with `EmptyState` (icon = `User` or `Settings`, description "Create a profile to save Claude command-line flags for reuse.", optional action = a small `Button` that triggers the "new profile" flow).

- [ ] **Step 4: Verify type-check + build**

Run:
```bash
npx tsc --noEmit
npm run build
```
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/ProfileModal.tsx
git commit -m "feat(profiles): modal uses ListRow + EmptyState"
```

---

## Task 15: Migrate `SessionHistory` rows

**Files:**
- Modify: `src/components/SessionHistory.tsx`

- [ ] **Step 1: Add import**

```tsx
import { ListRow } from './ui/ListRow';
```

- [ ] **Step 2: Replace each history row with `ListRow (compact)`**

Find the history-list mapping. Replace each rendered row with `<ListRow variant="compact" selected={...} onClick={...} leading={<Clock/>} trailing={<time/>}>{label}</ListRow>`. Preserve click behavior.

- [ ] **Step 3: Verify type-check + build**

Run:
```bash
npx tsc --noEmit
npm run build
```
Expected: both clean.

- [ ] **Step 4: Commit**

```bash
git add src/components/SessionHistory.tsx
git commit -m "feat(history): rows use ListRow"
```

---

## Task 16: `StatusBar` — unread-notification dot on the bell

**Files:**
- Modify: `src/store/appStore.ts`
- Modify: `src/components/StatusBar.tsx`
- Modify: `src/App.tsx` (increment on background finish)

- [ ] **Step 1: Add store state**

Open `src/store/appStore.ts`. Add two new fields to the persisted store slice and their setters, mirroring the existing patterns (e.g. `notifyOnFinish`):

```ts
// in the state interface
unreadNotificationCount: number;
incrementUnreadNotifications: () => void;
clearUnreadNotifications: () => void;
```

Implementation inside the store creator:

```ts
unreadNotificationCount: 0,
incrementUnreadNotifications: () => set((s) => ({ unreadNotificationCount: s.unreadNotificationCount + 1 })),
clearUnreadNotifications: () => set({ unreadNotificationCount: 0 }),
```

Add `unreadNotificationCount` to the persist middleware's `partialize` allow-list (find the existing allow-list keys and append this one), and update the matching test in `src/store/appStore.test.ts` — the test's "persisted keys allow-list" assertion must include the new key.

- [ ] **Step 2: Increment on background finish**

Open `src/App.tsx`. Find the existing `terminal-finished` event listener. Immediately before it fires the toast/notification, add:

```ts
if (document.hidden) {
  useAppStore.getState().incrementUnreadNotifications();
}
```

- [ ] **Step 3: Render the dot on the bell**

Open `src/components/StatusBar.tsx`. Read the unread count from the store:

```tsx
const unreadCount = useAppStore((s) => s.unreadNotificationCount);
const clearUnread = useAppStore((s) => s.clearUnreadNotifications);
```

Wrap the existing notification-bell button so that when `unreadCount > 0`, a 6 px accent dot appears at the top-right of the icon. Also invoke `clearUnread()` in the button's `onClick` (in addition to the existing toggle). Concretely:

```tsx
<Tooltip label={notifyOnFinish ? 'Notifications on' : 'Notifications off'} side="top">
  <button
    onClick={() => { setNotifyOnFinish(!notifyOnFinish); clearUnread(); }}
    className={`relative flex items-center h-[18px] w-[22px] justify-center rounded-[3px] transition-colors hover:bg-white/[0.06] ${
      notifyOnFinish ? 'text-text-secondary hover:text-text-primary' : 'text-text-tertiary hover:text-text-secondary'
    }`}
  >
    {notifyOnFinish ? <Bell size={11} strokeWidth={1.75} /> : <BellOff size={11} strokeWidth={1.75} />}
    {unreadCount > 0 && (
      <span
        aria-hidden
        className="absolute top-[1px] right-[2px] w-[6px] h-[6px] rounded-full bg-accent-primary"
      />
    )}
  </button>
</Tooltip>
```

- [ ] **Step 4: Verify type-check + build**

Run:
```bash
npx tsc --noEmit
npm run test:run
npm run build
```
Expected: all clean; the appStore persist-allow-list test now includes `unreadNotificationCount`.

- [ ] **Step 5: Manual visual check**

Run `npm run tauri dev`. Start a terminal, hide the window (minimize / switch app), and wait for a Claude session to finish. Refocus the app — the status-bar bell should show a dot. Click the bell — dot disappears.

- [ ] **Step 6: Commit**

```bash
git add src/store/appStore.ts src/store/appStore.test.ts src/App.tsx src/components/StatusBar.tsx
git commit -m "feat(statusbar): unread-notification dot"
```

---

## Task 17: `StatusBar` — optional global progress stripe

**Files:**
- Modify: `src/store/appStore.ts`
- Modify: `src/components/StatusBar.tsx`
- Modify: `src/lsp/*.ts` (call the setter on start/ready)
- Modify: any git fetch/pull invocation site that already tracks local `loading` — publish it up

- [ ] **Step 1: Add store state**

In `src/store/appStore.ts`:

```ts
// in the state interface
globalBusy: string | null;              // label of the currently-busy activity (e.g. 'LSP starting…') or null
setGlobalBusy: (label: string | null) => void;
```

Implementation:

```ts
globalBusy: null,
setGlobalBusy: (label) => set({ globalBusy: label }),
```

Do **not** persist `globalBusy` — omit from `partialize`. It's ephemeral.

- [ ] **Step 2: Render the stripe above the status bar**

In `src/components/StatusBar.tsx`, import `ProgressStripe`:

```tsx
import { ProgressStripe } from './ui/ProgressStripe';
```

Read the state:

```tsx
const globalBusy = useAppStore((s) => s.globalBusy);
```

Wrap the current `<div className="h-[22px] ...">` in a fragment and add the stripe immediately above it:

```tsx
return (
  <div className="flex flex-col shrink-0">
    {globalBusy && <ProgressStripe />}
    <div className="h-[22px] ...">
      {/* existing content unchanged */}
    </div>
  </div>
);
```

- [ ] **Step 3: Hook LSP startup**

Open `src/lib/lsp/lspClient.ts` (or wherever the LSP start/ready handshake lives). At the moment the client transitions to `starting`, call `useAppStore.getState().setGlobalBusy('Starting language server…')`. When the client transitions to `ready` (or errors), call `useAppStore.getState().setGlobalBusy(null)`.

If multiple language servers may start concurrently, keep a **counter** in the module (not the store) and only clear the store label when the counter drops to zero — otherwise the last one ready clears the stripe even if others are still starting.

- [ ] **Step 4: Hook git fetch/pull**

Find the sites that already track a local `loading` flag around `git_fetch` / `git_pull_branch` invocations (search: `git_fetch\|git_pull_branch`). For each, mirror the local `loading` to `setGlobalBusy('Fetching…')` / `setGlobalBusy('Pulling…')` and clear it on completion/error. Keep the local `loading` state as-is (it drives per-panel UI).

- [ ] **Step 5: Verify type-check + build**

Run:
```bash
npx tsc --noEmit
npm run build
```
Expected: both clean.

- [ ] **Step 6: Manual visual check**

Run `npm run tauri dev`. Open a `.ts` file to trigger LSP startup — a 2 px accent stripe should appear above the status bar and disappear once the LSP is ready. Trigger a `git pull` from the file-changes panel — the stripe should appear again while it runs.

- [ ] **Step 7: Commit**

```bash
git add src/store/appStore.ts src/components/StatusBar.tsx src/lib/lsp/lspClient.ts src/components/FileChangesPanel.tsx
git commit -m "feat(statusbar): global progress stripe (LSP + git ops)"
```

---

## Task 18: Tab "just-finished" green flash

**Files:**
- Modify: `src/index.css` (new keyframe)
- Modify: `src/components/TerminalTabs.tsx` (data-attribute + trigger)
- Modify: `src/store/terminalStore.ts` (transient `justFinishedAt` map)

- [ ] **Step 1: Add the keyframe**

Open `src/index.css`. After the existing `ct-shimmer` block, add:

```css
/* Tab bottom-underline "just finished" flash (Phase-2 UI polish). Runs once
   for 800 ms when a terminal transitions from busy → idle. Reduce-motion
   collapses to a static color change via the global cascade. */
@keyframes ct-tab-finish {
  0%   { background-color: rgb(74, 222, 128); }     /* --success */
  100% { background-color: var(--accent-primary); }
}
.ct-tab-finish::after {
  animation: ct-tab-finish 800ms cubic-bezier(0.25, 0.1, 0.25, 1) forwards;
}
```

- [ ] **Step 2: Track "just-finished" per terminal in the store**

Open `src/store/terminalStore.ts`. Locate the state-transition logic that already updates `terminalStates`. In the branch where a terminal moves from `busy` → `idle`, additionally set a timestamp:

```ts
// alongside the existing terminalStates update:
const justFinishedAt = new Map(get().justFinishedAt);
justFinishedAt.set(id, Date.now());
set({ justFinishedAt });

setTimeout(() => {
  const map = new Map(get().justFinishedAt);
  if (map.get(id) === Date.now()) return;   // defensive
  map.delete(id);
  set({ justFinishedAt: map });
}, 850);   // slightly longer than the 800ms animation so React unmounts the class cleanly
```

Add `justFinishedAt: Map<string, number>` to the interface. Initial value `new Map()`.

- [ ] **Step 3: Apply the class to the active underline**

Open `src/components/TerminalTabs.tsx`. Locate the tab's inner underline element (the current active-underline `<span>` at the bottom, around line 283). Extend its className to include `ct-tab-finish` when `justFinishedAt.get(terminal.id)` is set:

```tsx
{(isActiveTab || splitDropTargetId === terminal.id) && (
  <span
    className={`absolute left-2 right-2 bottom-0 h-[2px] rounded-t bg-accent-primary ${
      useTerminalStore.getState().justFinishedAt.has(terminal.id) ? 'ct-tab-finish' : ''
    }`}
  />
)}
```

Subscribe to `justFinishedAt` via a Zustand selector at the top of the component so React re-renders when it changes:

```tsx
const justFinishedAt = useTerminalStore((s) => s.justFinishedAt);
```

And use `justFinishedAt.has(terminal.id)` in the classname (not the `getState()` call inline).

For **inactive tabs** that finish, apply the same class briefly so the user sees the flash from across the tab strip. Reuse the existing `ct-working-tab::after` selector — that pseudo-element already sits at the same position. Add a sibling rule:

```css
.ct-tab-finish-inactive::after {
  content: '';
  position: absolute;
  left: 0; right: 0; bottom: 0;
  height: 2px;
  animation: ct-tab-finish 800ms cubic-bezier(0.25, 0.1, 0.25, 1) forwards;
}
```

And apply `ct-tab-finish-inactive` to the tab wrapper when `justFinishedAt.has(id) && !isActiveTab`.

- [ ] **Step 4: Verify type-check + build**

Run:
```bash
npx tsc --noEmit
npm run test:run
npm run build
```
Expected: all clean.

- [ ] **Step 5: Manual visual check**

Run `npm run tauri dev`. In an active terminal, type a Claude prompt and wait for it to finish. The active tab's bottom underline should flash green for ~800 ms then fade back to accent blue. Switch to another terminal while the first is busy and let it finish — the inactive tab flashes green in the strip.

- [ ] **Step 6: Reduce-motion verification**

Open Settings → Appearance → toggle "Reduce motion" ON. Re-run the same finish sequence. The color should still change (green → blue) but instantly, with no visible animation.

- [ ] **Step 7: Commit**

```bash
git add src/index.css src/components/TerminalTabs.tsx src/store/terminalStore.ts
git commit -m "feat(tabs): green flash on busy → idle transition"
```

---

## Task 19: Final verification + release prep

**Files:** none (verification only)

- [ ] **Step 1: Full type-check + build + tests**

Run:
```bash
npx tsc --noEmit
npm run test:run
npm run build
```
Expected: all green. If anything fails, stop and fix before proceeding.

- [ ] **Step 2: End-to-end visual smoke test**

Run `npm run tauri dev`. Walk through this checklist and confirm each item:

1. Sidebar's "PROJECT" header height/style is unchanged; expand/collapse works.
2. Sessions panel — refresh spinner + progress stripe both fire; selected row has stripe; empty state renders in a folder with no sessions.
3. FileTreePanel — hovering, selecting, expanding folders all still work; selected file has stripe.
4. TitleBar branch dropdown — current branch has stripe; other branches don't; filter still works.
5. Session widget dropdown — active session has stripe.
6. FileChangesPanel — expanded change row has stripe; group headers and staging unchanged.
7. WorktreeModal — worktrees list uses stripe; empty state renders when there are none.
8. SnippetsModal — selected snippet has stripe; empty-search state renders.
9. NewTerminalModal — recent/profile rows have stripe when selected; empty search state renders.
10. ProfileModal — profile rows have stripe; empty state renders.
11. SessionHistory — rows migrated.
12. StatusBar — unread bell dot appears on background-finish; clears on click.
13. StatusBar — global progress stripe appears during LSP startup and git pull.
14. Terminal tab — flashes green for ~800 ms on busy → idle.

- [ ] **Step 3: Reduce-motion pass**

Enable the in-app "Reduce motion" toggle. Repeat items 2, 13, and 14 above. Confirm no animation plays — stripes are static/absent, tab flash is instant, all list-row hover transitions are instant.

- [ ] **Step 4: Cross-platform sanity**

If a Mac is available, build there and repeat items 4, 12, 14. If only Windows: skip and note in the release PR.

- [ ] **Step 5: Prepare release notes entry**

Open `src/changelog.json`. Add a new entry above the existing 1.27.1 block:

```jsonc
{
  "version": "1.28.0",
  "date": "2026-07-13",
  "sections": [
    {
      "heading": "UI polish",
      "items": [
        "New selection stripe on list rows across sessions, file tree, branch and session widgets.",
        "Consistent tool-window headers with optional progress bar (LSP startup, git fetch/pull).",
        "Empty states in sessions, worktrees, snippets, new-terminal, and profiles.",
        "Status-bar notification bell shows an unread dot when a session finishes in the background.",
        "Terminal tab flashes green when a session finishes."
      ]
    }
  ]
}
```

Do not bump the version files here — that's the `/publish 1.28.0` command's job.

- [ ] **Step 6: Commit changelog**

```bash
git add src/changelog.json
git commit -m "docs: changelog for 1.28.0 UI polish"
```

- [ ] **Step 7: Hand off to release**

The full polish pass is done. The next command is `/publish 1.28.0`.

---

## Self-review checks (done — see below)

- **Spec coverage:** Every migration surface in the spec's Part 2 table maps to a task (6–15). Part 3 status-bar additions → Tasks 16, 17. Part 4 motion delta → Task 18 (tab flash), Task 5 (modal open — verified in place via `dialogMotion` which the primitive already uses). Part 1 primitives → Tasks 1–5. Verification section → Task 19.
- **No placeholders:** No TBD/TODO/vague "handle appropriately" instructions; every step has concrete code or a concrete search key.
- **Type consistency:** `ListRow` props (`selected`, `disabled`, `variant`, `leading`, `trailing`, `as`) are consistent across every consumer. `PanelHeader` `progress` prop shape (`{active, value?}`) is consistent. `computeStripeStyle` return type matches the consumer.
- **Ambiguity fixes applied:** Task 17 clarifies that `globalBusy` counts multiple concurrent LSP starts via a module counter (not the store).
