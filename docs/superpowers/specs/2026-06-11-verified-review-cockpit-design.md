# Verified Review Cockpit — Design

**Date:** 2026-06-11
**Status:** Approved (design); pending implementation plan
**Tagline:** *"claude-terminal is where agent code gets verified."*

## Goal

Make claude-terminal the place where developers review, verify, and commit
agent-written code — eliminating the last reasons to keep VS Code/IntelliJ
open. The two reasons research identified: (1) reviewing large changesets is
painful outside an IDE, and (2) only IDEs have language intelligence (type
errors, hover, go-to-definition). This feature attacks both at once, with a
combination no competitor has: **real LSP diagnostics and navigation inside
the diff-review surface, plus a "new diagnostics" merge gate.**

### Research grounding (June 2026)

- Market consensus: "when code is cheap, review is the bottleneck." Worktree
  isolation, orchestration boards, and diff viewers are now table stakes
  (Conductor, Sculptor, Nimbalyst, Cursor 2.0, Anthropic's own desktop app).
- No agent-manager GUI has language intelligence; it is the last honest
  reason users keep an IDE open. JetBrains Junie's most-praised trait is
  "IDE-grounded" verification.
- Industry direction is *feed LSP to the AI*, not replace LSP with AI
  (Claude Code v2.0.74 built-in LSP, Serena, opencode, Cursor shadow
  workspace).
- Windows is an open flank: Conductor is Mac-only, Sculptor/Codex launched
  Mac-first, Vibe Kanban is broken on Windows. claude-terminal is already
  Windows-native.

## Decisions made during brainstorming

| Decision | Choice |
|---|---|
| Flagship direction | Verified Review Cockpit (over full IDE-parity editor or orchestration board) |
| Unit of review | One card per dirty repo or worktree (uncommitted changes vs HEAD). No per-session attribution in v1. |
| Languages at launch | PATH detection first for any server; auto-install fallback for TypeScript (`typescript-language-server`), Python (`pyright`), Rust (`rust-analyzer`) |
| Hunk accept/reject | Accept = stage hunk (`git apply --cached`); Reject = reverse-apply from working tree with mandatory pre-reject snapshot (one-click restore) |
| AI pre-review | Lightweight: one headless `claude -p` structured verdict per changeset, manual trigger by default |
| Merge gate | Advisory, never blocking |
| LSP architecture | Minimal Rust client + stock Monaco providers (NOT monaco-languageclient — avoids Monaco 0.52→0.55 forced upgrade and the monaco-vscode-api version treadmill) |

## Architecture overview

```
┌─ Frontend ────────────────────────────────────────────────┐
│ ReviewInboxPanel (new, right tool-stripe)                  │
│   └─ ReviewCockpit view (new, full-window)                 │
│        ├─ per-hunk DiffEditor (extends InlineDiffView)     │
│        ├─ Monaco LSP providers (hover/def/markers)         │
│        └─ Gate bar (diagnostics + review progress + AI)    │
├─ Tauri IPC ───────────────────────────────────────────────┤
│ lsp_* commands + `lsp-diagnostics` event                   │
│ git_stage_hunk / git_revert_hunk / restore_rejected_hunk   │
│ ai_review_changeset                                        │
├─ Rust backend ────────────────────────────────────────────┤
│ lsp.rs — LspManager (new subsystem)                        │
│ hunk commands in commands.rs (git apply based)             │
│ verdicts + reject-snapshots in database.rs (SQLite)        │
└────────────────────────────────────────────────────────────┘
```

Existing assets reused: Monaco editor + DiffEditor (`FileEditorView.tsx`,
`InlineDiffView.tsx`), git plumbing in `commands.rs` (`get_file_diff`,
`scan_git_repos`, `list_worktrees`, staging/commit), `ToolStripe.tsx`,
SQLite (`database.rs`), the Claude spawn plumbing, and the
`invoke`/event IPC pattern.

## Component 1: LSP subsystem (`src-tauri/src/lsp.rs`)

- **`LspManager`** keyed by `(workspace_root, language)`, held in `AppState`
  alongside `TerminalManager`. Servers spawn lazily on first review or file
  open in a root.
- **Acquisition order:**
  1. Binary found on PATH → use it (mirrors Claude Code's own LSP plugin
     behavior).
  2. Auto-install into the app data dir: `typescript-language-server` +
     `typescript` and `pyright` via npm (the same shell-out plumbing used
     for Claude Code installs); `rust-analyzer` per-target binary download
     from GitHub releases.
  3. New Settings page "Language Servers": per-language status
     (PATH / installed / missing), install button, restart button,
     stderr log viewer.
- **Transport:** Helix-style three async tasks per server — stdout reader
  (Content-Length framing codec), stdin writer, stderr logger. Implemented
  with `tokio::process`; `lsp-types` crate for typed structs where
  convenient. No protocol framework needed.
- **Lifecycle:** Rust owns `initialize`/`shutdown` handshake,
  restart-with-backoff, max-restart cap, 120s request timeout (Zed's
  numbers).
- **IPC surface:**
  - `lsp_did_open` / `lsp_did_change` / `lsp_did_close` — document sync
    (frontend debounces `didChange`).
  - `lsp_request(root, language, method, params)` — generic JSON-RPC
    passthrough so hover/definition/completion are one frontend call each
    and future LSP features cost nothing on the Rust side.
  - Pushed `lsp-diagnostics` event `{root, uri, diagnostics}` (same pattern
    as `terminal-output`).
- **Position encoding:** Monaco and LSP both default to UTF-16 — positions
  pass through unconverted; document this invariant in code.

## Component 2: Review Inbox

- New icon on the right `ToolStripe`: **Review**, with a badge showing
  total pending hunks / new-diagnostic count across all cards.
- **One card per dirty repo or worktree**, discovered via existing
  `scan_git_repos` + `list_worktrees`, refreshed on the same cadence as
  `FileChangesPanel`.
- Card contents: repo/branch name, terminal sessions currently running in
  that root (informational link only — no change attribution), files/hunks
  changed, **diagnostics chip** (`✓ clean` / `✗ N new` /
  `LSP unavailable`), **AI verdict chip**, last-change time.
- Clicking a card opens the **Cockpit**: full-window view (SettingsWindow
  pattern). Left rail = changed-file list with per-file review progress;
  center = Monaco DiffEditor.

## Component 3: Per-hunk review engine

- Hunks parsed from `get_file_diff` unified-diff output in TypeScript
  (pure function, unit-tested): diff text → hunk list → minimal
  single-hunk patch generation.
- Gutter widgets on the DiffEditor's modified side:
  - **Accept** → `git_stage_hunk`: `git apply --cached` of the minimal
    patch.
  - **Reject** → `git_revert_hunk`: reverse-apply from the working tree,
    **after** writing a snapshot `{file path, full pre-reject content,
    hunk patch, timestamp}` to a new SQLite `reject_snapshots` table.
- A "Rejected" drawer in the cockpit lists snapshots with one-click
  restore (`restore_rejected_hunk`). Snapshots pruned by a retention
  setting.
- File-level Accept All / Reject All. Keyboard triage: `j`/`k` next/prev
  hunk, `a` accept, `r` reject.
- **Interaction with the existing auto-stage setting** (`GitPage`:
  none/tracked/all): auto-stage modes other than `none` defeat per-hunk
  staging. While a cockpit is open for a repo, auto-stage is suspended for
  that repo; the cockpit shows a one-line notice when it does so.

## Component 4: Language intelligence in the diff (the differentiator)

- The DiffEditor's modified side (the working-tree file) gets:
  - **Diagnostics squiggles** via `monaco.editor.setModelMarkers` fed by
    `lsp-diagnostics` events.
  - **Hover** via `registerHoverProvider` → `lsp_request('textDocument/hover')`.
  - **Go-to-definition** via `registerDefinitionProvider` → opens the
    target file in the existing editor tabs at the target line.
- **"New diagnostics" definition (v1):** diff-aware filtering —
  diagnostics in changed files whose range intersects added/modified lines
  count as *new*. No second LSP run against HEAD, no temp checkouts.
  (True HEAD-baseline comparison is a possible v2 upgrade.)
- **Merge gate:** the cockpit's Commit button carries gate state —
  `N new diagnostics · M unreviewed hunks · AI: low risk`. Advisory only:
  commit is never blocked, but committing red code is impossible to miss.

## Component 5: AI pre-review verdict

- `ai_review_changeset(root)` runs headless
  `claude -p --output-format json` with a structured prompt over the
  card's diff → `{summary, risk: low|medium|high, flagged_hunks[],
  reasons}`.
- Cached in SQLite keyed by `(repo_root, diff_hash)` — never re-runs on an
  unchanged changeset.
- Trigger: manual button on the card (default); optional
  auto-on-card-creation toggle in settings, labeled with a token-cost
  warning. Flagged hunks get a ⚑ marker in the cockpit hunk gutter.

## Error handling

- **LSP server crash/missing:** card chip degrades to
  `LSP unavailable (<language>)` with click-through to the Language
  Servers settings page. Review works fully without intelligence.
  Restart cap prevents crash loops; stderr captured and viewable.
- **Stale hunk** (`git apply` fails because the file changed since the
  diff was taken): re-diff the file and show "changeset moved — re-review
  this file" instead of a raw git error.
- **AI verdict failure:** chip shows a retry affordance; never blocks the
  card.
- All Rust commands keep the existing `Result<T, String>` convention.

## Testing

- **Vitest:** hunk parser (unified diff → hunks → minimal patch
  round-trip), diff-aware diagnostic filtering, gate-state reducer.
- **Rust unit tests:** Content-Length framing codec (split, merged, and
  partial frames), acquisition path resolution, reject-snapshot store.
- **Dogfood e2e per release:** tsserver + rust-analyzer running against
  this repository itself — the app reviewing its own diffs.

## Phasing (each phase independently shippable)

1. **LSP foundation** (~2–3 wks): `lsp.rs`, acquisition + settings page,
   diagnostics squiggles in the existing `InlineDiffView` and editor.
2. **Review Inbox + per-hunk accept/reject** (~2 wks): inbox panel,
   cockpit view, hunk engine with reject safety net.
3. **Gate bar + AI verdict** (~1 wk).
4. **Hover/go-to-def in diffs + completions in the regular editor**
   (~1–2 wks): the shared-foundation payoff that also moves the plain
   editor toward IDE parity.

## Explicitly out of scope (v1)

- Per-session change attribution and worktree-per-session-by-default
  (separate backlog item; the inbox already handles worktrees as cards).
- Step-through debugging (DAP), interactive rebase, 3-way merge editor.
- monaco-languageclient / monaco-vscode-api migration.
- Multi-pass specialist AI review (correctness/security/perf panels).
- Cloud/remote agent hosting.
