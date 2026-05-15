# IntelliJ-Style UI/UX Overhaul — Design

**Date:** 2026-05-14
**Target release:** v1.22.0
**Status:** Approved, ready for plan

## Goal

Move ClaudeTerminal closer to the IntelliJ IDEA 2026 New UI in five concrete ways:

1. **Sidebar = Explorer only.** Terminal list and Tools footer move out so the file tree gets full height.
2. **Changelists Lite** in the File Changes panel — IntelliJ-style local grouping of changed files.
3. **Tools** moves from the sidebar footer to a single dropdown in the title bar.
4. **Settings** becomes a large categorized window instead of a narrow modal.
5. **Active-work indicator** on terminal tabs — a pulse while Claude is streaming output.

This is an evolution, not a redesign. The codebase already has the IJ visual system in place (5-step elevation tokens, IJ-blue accent, `--ij-stripe` / `--ij-divider`, Inter + JetBrains Mono fonts, thin scrollbar). The work below standardizes those tokens, adds the new features, and fills the remaining gaps.

## Decisions reached during brainstorming

| Question | Decision |
|---|---|
| Overall layout | **B** — Streamlined IntelliJ: sidebar = Explorer only, terminals stay as main content, no new icon rails |
| Changelist scope | **Lite** — named lists + create/rename/delete + move via menu + per-list "Stage all", no "active" list, no shelf, no drag-and-drop |
| Where Tools goes | **A** — single dropdown button in the title bar |
| Settings shape | **S1** — large centered modal (~85% viewport, max-w-1100px), backdrop blur, ESC to close |
| Settings categories | Approved tree below (Appearance & Behavior / Editor / Terminal / Version Control / Claude Code / Tools / Privacy & About) |
| Terminal discovery without sidebar list | **ii** — Recent Terminals dropdown in title bar (up to 20 most-recent, status dot + nickname + branch) |
| Keymap | Read-only list (edit deferred to Phase 2) |
| Active-work tab indicator | Pulse the status dot + shimmer the tab underline when `Date.now() − lastOutputAt < 2000ms` |

---

## Section 1 — Layout & navigation

### Title bar (left to right)

| Zone | Item | Status |
|---|---|---|
| Left | App icon (toggles sidebar) | unchanged |
| Left | Project breadcrumb dropdown → command palette | unchanged |
| Left | Branch switcher | unchanged |
| Center | Drag region, brand, version | unchanged |
| Right | UpdatePill | unchanged |
| Right | File Changes toggle, Agent Teams toggle, Hints toggle | unchanged |
| Right | **Recent Terminals dropdown** | **NEW** |
| Right | **Tools dropdown** | **NEW** |
| Right | Settings button (now opens SettingsWindow, not SettingsModal) | refactored |
| Right | Window controls (Windows: min/max/close; macOS: traffic lights at left) | unchanged |

**Recent Terminals dropdown.** Icon: a stack/list glyph. Popover shows up to 20 most-recently-active terminals: status dot + nickname (falling back to label) + branch chip + working-directory tail. Clicking sets that terminal active. The footer links to "Open Command Palette" (the existing Ctrl+P palette already searches across terminals).

**Tools dropdown** (title bar). Icon: wrench. Flat menu with seven items: Workspaces, Snippets, Session History, Session Timeline, Claude Config, Memory Editor, Manage Profiles. Each item launches the existing modal — no new flows in this release. Note: the same items also appear under the **Tools** *category* in the Settings window (§3) — that's intentional secondary discoverability, not a renamed feature.

### Sidebar

| State | Today | After |
|---|---|---|
| Expanded (`!sidebarCollapsed`) | Header "Terminals" → terminal list with filter → splitter → Explorer (when `showFileTree`) → splitter → Tools footer (collapsible) | Header "Project" → Explorer (`FileTreePanel`) **full-height**. No terminal list. No Tools footer. |
| Collapsed (`sidebarCollapsed`, 48px) | Icon rail with: new-terminal button + per-terminal status dots + Workspaces / Snippets / Session History / Profiles + expand button | Icon rail with only the expand button (matches IJ when there's a single tool window). No terminals, no tools. |

Stale store keys after this change: `explorerHeightRatio`, `toolsCollapsed`. Keep them in the persist payload for this release (no UI references); drop in a follow-up cleanup to avoid disturbing Zustand merge mid-flight.

`useKeyboardShortcuts` — `Ctrl+B` keeps its current semantics (toggle sidebar open/closed). The keymap entry's description updates to "Toggle Explorer" instead of "Toggle Sidebar".

---

## Section 2 — File Changes & Changelists Lite

The panel structure (Repositories ⇕ Changes ⇕ Stashes ⇕ Commit bar) keeps its shape. Changelists are a grouping layer inside the unstaged "Changes" section.

### Visual layout

Inside the existing Changes scroll area:

```
Staged (n)                                                  – Unstage all
  ▾ src/App.tsx                                                M
  ▾ src/store/foo.ts                                           A

Default (n)                                                 + Stage all
  README.md                                                    M
  package.json                                                 M
  notes.txt                                                    ?

Feature-A (n)              ⋯ rename / delete                + Stage all
  src/Sidebar.tsx                                              M
  src/Tools.tsx                                                A

Feature-B (n)              ⋯                                + Stage all
  ...
```

Section headers above "Staged" and "Default": existing styling (uppercase 10.5px, IJ stripe on staged). User-named changelist headers use the same style with an additional `⋯` action menu (rename / delete). "Default" header has no `⋯` (cannot rename or delete).

`+ List` button appears at the top of the Changes section (next to the section title) to create a new changelist.

### Data model (SQLite, additive)

```sql
CREATE TABLE IF NOT EXISTS changelists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_path TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(repo_path, name)
);

CREATE TABLE IF NOT EXISTS changelist_files (
  repo_path TEXT NOT NULL,
  file_path TEXT NOT NULL,
  changelist_id INTEGER NOT NULL REFERENCES changelists(id) ON DELETE CASCADE,
  PRIMARY KEY (repo_path, file_path)
);

CREATE INDEX IF NOT EXISTS idx_changelist_files_repo ON changelist_files(repo_path);
CREATE INDEX IF NOT EXISTS idx_changelist_files_list ON changelist_files(changelist_id);
```

**"Default" is implicit.** Files without a row in `changelist_files` appear under Default. So Default is always present, never created, never deletable.

**Sticky mappings.** When a file is committed and its status disappears from `git status`, we leave the mapping in `changelist_files`. If that file is modified again later, it returns to its prior changelist (mirrors IntelliJ behavior). No background cleanup task required.

**Deletion cascade.** Deleting a named changelist drops its mappings via `ON DELETE CASCADE`. Those files revert to Default on the next refresh.

**Per-repo scoping.** `repo_path` is the absolute path returned from existing git scanning logic. Worktrees have their own working trees and therefore their own changelists.

### New Tauri IPC commands (added to `commands.rs`)

| Signature | Purpose |
|---|---|
| `list_changelists(repo_path: String) -> Vec<ChangelistInfo>` | Returns user-named lists with file counts (joined against current `git status` output). Always includes a synthetic `Default` entry first with the count of unassigned changed files. |
| `create_changelist(repo_path: String, name: String) -> i64` | Validates: non-empty, ≤ 80 chars, not `"Default"` (case-insensitive), unique per repo. Returns new row id. |
| `rename_changelist(id: i64, new_name: String) -> ()` | Same validation as create. |
| `delete_changelist(id: i64) -> ()` | Cascade-drops mappings. |
| `assign_files_to_changelist(repo_path: String, file_paths: Vec<String>, changelist_id: Option<i64>) -> ()` | `None` ⇒ Default (deletes existing mappings for these paths). Otherwise UPSERTs. |

Existing git commands (`git_stage_files`, `git_unstage_files`, `git_commit`, `git_discard_file`, `get_terminal_changes`, `get_path_changes`) are **not** modified. The "Stage all" button on a changelist header calls `git_stage_files` with that list's paths.

### UI interactions

- **Create list:** `+ List` button → inline input field at top of Changes → name validated → `create_changelist` → optimistic local insert + refetch.
- **Rename list:** `⋯` → Rename → header label becomes an inline input. Confirm → `rename_changelist` → refetch.
- **Delete list:** `⋯` → Delete → confirm dialog (gated by `vcs.changelistsConfirmDelete` setting, default true) → `delete_changelist` → files move to Default.
- **Move file:** right-click any file row → "Move to Changelist ▸" submenu → list of changelists (current one marked with ✓) → `+ New changelist…` at the bottom → `assign_files_to_changelist`.
- **Stage all in list:** header button → `git_stage_files(list.paths)`. Files migrate to the Staged section above.
- **Commit:** unchanged. The bottom commit bar commits whatever is currently staged. Changelists are a pre-commit organization tool only.

### Component split (refactor of `FileChangesPanel.tsx`)

`FileChangesPanel.tsx` is 1466 lines today and grows by ~400 if changelists are added in place. Split into siblings under `src/components/changes/`:

- `FileChangesPanel.tsx` — coordinator (~250 lines): owns the splitter, fetches `result`/`stashes`, passes data down.
- `RepositoriesSection.tsx` — extracted from current Repositories block (`RepoRow`, `WorktreeRow` move with it).
- `ChangelistSection.tsx` — **new**: renders Staged + Default + named changelists. Owns context menus and the `+ List` flow.
- `StashesSection.tsx` — extracted from current Stashes block.
- `CommitBar.tsx` — extracted from current commit-bar block (commit / & push / stash).

`RepoSelectionContext` stays in `FileChangesPanel.tsx`.

---

## Section 3 — Settings window

Replaces `SettingsModal.tsx` (one 780-line file) with `SettingsWindow.tsx` + per-category pages.

### Shell

Large centered modal: `w-[92vw] max-w-[1100px] h-[80vh] max-h-[720px]`, IJ elevation-4, ring + shadow, backdrop blur. ESC closes (consistent with current behavior). No "Apply" button — Zustand setters persist immediately, matching today's behavior.

Layout:

```
┌─ Header (44px) — "Settings"   [Search settings…  Ctrl+,    ] [×] ┐
├────────────────────────────────────────────────────────────────────┤
│ Category tree (200px)         │ Content pane (1fr)                  │
│  Appearance & Behavior        │                                     │
│    ▸ Appearance               │                                     │
│    ▸ Notifications            │                                     │
│    ▸ Startup & Session        │                                     │
│    ▸ Keymap (read-only)       │                                     │
│  Editor                       │                                     │
│    ▸ General                  │                                     │
│    ▸ Font                     │                                     │
│  Terminal                     │                                     │
│    ▸ Appearance               │                                     │
│    ▸ Behavior                 │                                     │
│    ▸ Pastes                   │                                     │
│  Version Control              │                                     │
│    ▸ Git                      │                                     │
│    ▸ Changelists              │                                     │
│  Claude Code                  │                                     │
│    ▸ Defaults                 │                                     │
│    ▸ Updates                  │                                     │
│  Tools                        │                                     │
│    ▸ Profiles                 │                                     │
│    ▸ Snippets                 │                                     │
│    ▸ Memory                   │                                     │
│  Privacy & About              │                                     │
│    ▸ Privacy                  │                                     │
│    ▸ About                    │                                     │
└─────────────────────────────────────────────────────────────────────┘
```

The active category gets the existing `--ij-stripe` 2px left-border + `accent-glow` background — same pattern used in the Sidebar.

### Search behavior

Top input does live filtering. As the user types:

- Categories with no matching settings collapse to greyed-out labels.
- Matching settings in the right pane get a subtle yellow highlight (border).
- If exactly one category contains matches, it's auto-selected.
- Empty query restores the normal tree.

Matching uses a flat index built at mount time: an array of `{ categoryId, settingId, label, keywords[] }` per page (each page exports its index). Case-insensitive substring match against `label` and `keywords`. Cheap, ~50 entries total.

### Settings per category

`NEW` = new persisted key. Everything else is lifted from the current modal.

**Appearance & Behavior**

- *Appearance:* theme (`themeMode`: `'dark' | 'light' | 'auto'`) NEW · density (`uiDensity`: `'compact' | 'comfortable' | 'spacious'`, default `'comfortable'`) NEW · accent color (`accentColorHex`, default `#3574F0`) NEW · UI font scale (`uiFontScale`: 0.85–1.25, default 1.0) NEW · reduce motion (`uiReduceMotion`, default `false`) NEW
- *Notifications:* `notifyOnFinish` (existing) · sound on/off (`notificationSoundEnabled`, default `false`) NEW · DND window (`dndEnabled`, `dndStart` "HH:mm", `dndEnd` "HH:mm") NEW
- *Startup & Session:* `restoreSession` (existing) · auto-save interval (`sessionAutoSaveIntervalSec`, default 30, replacing today's hard-coded 30) NEW · confirm-on-close (`confirmOnAppClose`, default `true`) NEW
- *Keymap:* read-only table of every shortcut in `useKeyboardShortcuts.ts` (today's list, polished into a sortable table)

**Editor**

- *General* NEW: `editor.tabSize` (default 2) · `editor.renderWhitespace` (default `false`) · `editor.wordWrap` (default `true`) · `editor.minimap` (default `false`) · `editor.autoSaveOnBlur` (default `false`)
- *Font* NEW: `editor.fontFamily` (default Monaco's system stack) · `editor.fontSize` (default 13) · `editor.lineHeight` (default 1.5)

(Wired into the Monaco editor used in `FileEditorView.tsx` / `InlineDiffView.tsx`.)

**Terminal**

- *Appearance:* font, size, line height, cursor style, cursor blink, scrollback, theme, BiDi — all existing.
- *Behavior* NEW: shell type for plain-shell tabs (`terminal.shellPathOverride`, default empty → use platform default) · copy-on-select (`terminal.copyOnSelect`, default `false`) · paste shortcut (`terminal.pasteShortcut`: `'ctrl+v' | 'ctrl+shift+v'`, default `'ctrl+shift+v'`)
- *Pastes:* `pasteAutoDetectEnabled`, thresholds, prompt template, retention — all existing.

**Version Control**

- *Git* NEW: commit-message template (`vcs.commitMessageTemplate`, default empty, supports `{branch}`, `{date}`) · default auto-stage policy (`vcs.defaultAutoStage`: `'none' | 'tracked' | 'all'`, default `'none'`) · default merge strategy (`vcs.defaultMergeStrategy`: `'merge' | 'rebase' | 'ff-only'`, default `'merge'`)
- *Changelists* NEW: confirm-before-delete toggle (`vcs.changelistsConfirmDelete`, default `true`)

**Claude Code**

- *Defaults:* `defaultClaudeArgs` (existing) · default model (`claude.defaultModel`: `'opus' | 'sonnet' | 'haiku' | null`, default `null`) NEW · Claude binary path override (`claude.binaryPathOverride`, default empty → use `claude_path.rs` resolution) NEW
- *Updates:* existing Claude CLI version + update block

**Tools**

- *Profiles:* launches existing `ProfileModal` (manage list)
- *Snippets:* launches existing `SnippetsModal`
- *Memory:* launches existing `MemoryEditor`

(The Tools dropdown in the title bar is the primary entry. This Settings category is a discoverability backup.)

**Privacy & About**

- *Privacy:* `telemetryEnabled`, `errorReportingEnabled` — both existing.
- *About:* app version (via `getVersion`), Claude version (via `get_claude_version`), update channel info (read-only string for now), GitHub repo link.

### Component file structure

```
src/components/settings/
  SettingsWindow.tsx           # replaces SettingsModal.tsx
  SettingsCategoryTree.tsx     # left nav
  SettingsSearch.tsx           # top search + filter context
  index.ts                     # exports + the searchable settings index
  categories/
    AppearancePage.tsx
    NotificationsPage.tsx
    StartupSessionPage.tsx
    KeymapPage.tsx
    EditorGeneralPage.tsx
    EditorFontPage.tsx
    TerminalAppearancePage.tsx   # lifted block + existing TerminalAppearancePreview
    TerminalBehaviorPage.tsx
    TerminalPastesPage.tsx       # lifted block
    GitPage.tsx
    ChangelistsPage.tsx
    ClaudeDefaultsPage.tsx
    ClaudeUpdatesPage.tsx        # lifted block
    ToolsPage.tsx                # launches existing modals
    PrivacyPage.tsx              # lifted block (telemetry + error reporting)
    AboutPage.tsx                # lifted version block
```

Each page is a thin wrapper around Zustand setters — no duplicated state logic.

---

## Section 4 — Visual polish

What the codebase already has and we **keep**: 5-step elevation system (#1E1F22 → #4E5157), IJ-blue accent (#3574F0), Inter UI + JetBrains Mono terminal fonts, thin scrollbar with hover-darken, 2px left-accent stripe on active rows, 11–13px UI text, frameless window + custom title bar drag region.

### Gap fills

- **Standardize tool-window headers** — 28px height, `--elevation-1` background, hard divider underneath, 10.5px uppercase title with `letter-spacing: 0.06em`, right-aligned action icons. Apply across `HintsPanel`, `OrchestrationPanel`, the new Explorer-only sidebar header, and the new `ChangelistSection`.
- **Density** — driven by a CSS var `--ui-row-py` on `:root` (8px / 6px / 4px for spacious / comfortable / compact). Components reference `py-[var(--ui-row-py)]` on their primary rows (sidebar items, file rows, changelist entries, settings rows). Default = comfortable (matches today).
- **Accent color** — preset picker (5 hues) + custom-hex input rewrites the existing CSS variables: `--accent-primary`, `--accent-secondary`, `--accent-glow`, `--ij-stripe`, `--ij-tab-underline`. Tailwind classes already read from these tokens via `tailwind.config.js`, so no per-component changes needed.
- **Light theme** — flipping `--elevation-0..4` to IJ Light tokens (`#F7F8FA → #FFFFFF` ramp), `text-primary: #27282E`, etc. xterm theme system in `lib/terminalThemes` already has the light theme — flip it in sync.
- **Focus rings** — adopt `focus:ring-1 focus:ring-accent-primary/55` as the standard on inputs / selects / textareas (replaces today's inconsistent mix).
- **Hover states** — structural rows use `hover:bg-elevation-2` (sidebar items, settings tree rows, changelist headers). Inline icon buttons keep their denser `hover:bg-white/[0.04..0.06]` overlays.
- **Reduce motion** — root `data-reduce-motion="true"` attribute when the setting is on. CSS rule `[data-reduce-motion="true"] *, [data-reduce-motion="true"] *::before, [data-reduce-motion="true"] *::after { animation-duration: 0.001s !important; transition-duration: 0.001s !important; }`. Framer Motion's `Reorder`/`AnimatePresence` durations also keyed off the attribute via `useReducedMotion`-style hook.

### Active-work tab indicator

The current `TerminalTabs.tsx` shows a status dot per tab. Add: **pulse the dot + shimmer the tab underline** while the terminal is actively producing output.

**Detection.** Cheap and language-agnostic — no pattern matching against Claude's prompt strings.

- Add `lastOutputAt: number` to the in-memory `TerminalInstance` (not persisted; resets on restart).
- `handleTerminalOutput` writes `lastOutputAt = Date.now()` on every output chunk.
- Derived state: `isWorking = (Date.now() - lastOutputAt) < 2000`.
- Re-evaluated by a single root-level `useEffect` that sets up a 500ms `setInterval` **only when at least one terminal has `lastOutputAt` within the last 5 seconds**, otherwise it stops the interval. Forces re-render of just the tab strip (via a tick counter Zustand selector). Idle terminals don't poll.

**Visual.**

- Active tab + working → solid `--ij-tab-underline` underline AND pulsing dot. The dot animation: `@keyframes ct-pulse-dot { 0%,100%{transform:scale(1);opacity:1} 50%{transform:scale(1.35);opacity:0.55} }` at 1.4s ease-in-out infinite, plus `box-shadow: 0 0 6px {status-color}` for a glow.
- Background tab + working → **shimmer-only** underline (no static color, since it's not the active tab), plus pulsing dot. Shimmer keyframes: `@keyframes ct-shimmer { 0%{background-position:-120px 0} 100%{background-position:240px 0} }` at 1.6s linear infinite, with `background: linear-gradient(90deg, transparent 0%, #3574F0 30%, #548AF7 50%, #3574F0 70%, transparent 100%)`.
- Both animations are slow (1.4s / 1.6s cycles, no off→on flashing) — well under WCAG 2.3.1 flash thresholds.

**Reduce motion override.** When `ui.reduceMotion` is on, both animations disable. Active+working uses a static dot glow + the regular static underline; background+working uses the static dot glow only (no shimmer at all).

**Independent of "unread."** `unread = received output while not the active tab` (existing). `working = receiving output right now` (new). Both can be true simultaneously — an unread tab that's actively producing output gets the corner unread bead **and** the pulse.

### What's not changing visually

Font stack, window frame, mac traffic lights, Windows window buttons, color token names, xterm theme list (we add a "light" flip — themes are already there), `BottomTerminalPane`, `AutoUpdater`, `ToastContainer`, and any modal not listed in §3.

---

## Section 5 — Migration, risk & rollout

### State migration

**Frontend (Zustand persist → localStorage):** All current keys keep their setters and meanings — no removals. New keys (listed in §3) get defaults in the store initializer; Zustand's persist `merge` strategy applies them to upgrading users without a version bump. The stale `explorerHeightRatio` and `toolsCollapsed` keys stay in the persist payload for one release with no UI consumers; drop them in a follow-up cleanup so a mid-flight Zustand merge doesn't disturb other settings.

**Backend (SQLite at `claudeterminal.db`):** Two new tables added via `CREATE TABLE IF NOT EXISTS` in the existing startup migration in `database.rs`. Additive only — no changes to `profiles`, `workspaces`, `session_history`. Safe to roll back to the prior binary; new tables sit dormant.

### Removed / superseded

- `SettingsModal.tsx` → split into `SettingsWindow.tsx` + `categories/*`. Old file deleted.
- Sidebar Tools footer (Workspaces / Snippets / Session History / Session Timeline / Claude Config / Memory Editor / Manage Profiles) → removed. All seven move to the new Tools dropdown in the title bar.
- Sidebar terminal list + its filter input + drag-reorder → removed. Sidebar's sole content becomes the Explorer.

### Risk areas

1. **Power users miss the sidebar terminal list.** Mitigations: Recent Terminals dropdown in title bar, Ctrl+P palette already lists terminals, status bar count is still clickable to toggle the sidebar.
2. **Settings refactor touches every setting key.** Mitigation: each new category page is a thin wrapper around the same Zustand setters — no state logic gets rewritten. Manual smoke-test list: terminal appearance preview renders, paste settings persist, restore-session still toggles, error reporting still pushes to Rust on toggle.
3. **`FileChangesPanel.tsx` already 1466 lines.** Adding changelists in place would push it past 2000. Mitigation: the four-way split described in §2.
4. **Tab-pulse re-render scope.** Mitigation: the 500ms tick lives in one root effect and only runs when at least one terminal has `lastOutputAt` within the last 5 seconds. Tab strip subscribes via a Zustand selector, so non-tab subtrees don't re-render. Profile before merging.
5. **Accent-color CSS-var swap during running animations.** Smoke-test the AutoUpdater progress bar while switching accents to confirm no stale-frame artifacts.

### Rollout

- Single release, **v1.22.0**. No feature flags.
- Use the existing `/publish` slash command (it bumps `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `README.md`, runs `cargo check`, commits, tags, pushes — GitHub Actions builds and signs).
- Add a `src/changelog.json` entry so `WhatsNewModal` highlights on first launch: **"New Settings panel · Changelists · Streamlined sidebar · Live working indicator."**
- Update `README.md` screenshots (the v1.20.x screenshots will be stale after this lands).

### Out of scope (Phase 2 — separate spec later)

- Editable keymap (capture combos, conflict detection, runtime rebind)
- Git blame on hover
- Auto-fetch on interval
- Custom notification sound files (Phase 1 ships sound on/off only)
- Drag-and-drop files between changelists (Phase 1 = right-click menu)
- "Active" changelist concept where new edits auto-assign
- Per-list commit dialog with checkboxes
- Full main-menu (File / Edit / View / …) — Tools is the only new title-bar menu in Phase 1
