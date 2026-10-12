# Learn Cards (Plan 1) - design

Date: 2026-10-12
Status: draft, awaiting review
Sketch: https://claude.ai/artifact/9aviw3G5svH64FeQyH3yZ1

## Goal

After an agent changes code, let the user learn 1-3 short things from that change
(a design pattern, a system design idea, a language syntax point) instead of only
receiving code. Human in the loop: every card asks the user to predict an answer
before the explanation is revealed.

Why: Anthropic's Jan 2026 RCT found developers who delegated to AI scored 17 points
lower on comprehension, while "generate then comprehend" users kept their skill
(65%+). Learn Cards make "generate then comprehend" the default path.

## Success criteria

- A finished agent session, or a manual "Learn from current changes" click, with a git diff produces 1-3 cards in under 60 s.
- Every card quotes lines that really exist in the session diff (verified in Rust).
- The agent and terminal are never blocked or interrupted by Learn.
- Turning Learn off in Settings hides every Learn surface and stops all generation.

## Decisions

| # | Decision | Reason |
| --- | --- | --- |
| D1 | **Feature flag `learnEnabled`, default ON**, persisted in `appStore`, toggle in a new Settings page *Agents > Learn*. | User requirement. Same pattern as `lspEnabled`. |
| D2 | **Sending code to Claude needs a separate one-time consent `learn_ai_consent` (user_meta, default off, checked in Rust).** With the flag ON and no consent, the Learn tab shows a one-line explainer and an *Allow* button. | The app's privacy rule is "nothing leaves the device by default" (`PrivacyPage` External AI summaries is off by default and enforced in Rust). Flag ON by default keeps the feature visible; consent keeps that rule. Independent of `external_summary_enabled` so the two features do not toggle each other. |
| D3 | Context source is the **git diff of the terminal's working tree vs HEAD** (tracked + untracked, size-capped), plus the session's first user prompt as "goal". | Agent-agnostic: works for Claude, Codex, Cursor, Antigravity and custom agents. Transcripts differ per agent and are only partly parsed today. |
| D4 | Generation runs through the user's own `claude -p --model haiku`, same spawn pattern as `summarize_session` (timeout, `kill_on_drop`, scrub). | Reuses a proven path; no API keys, no new network dependency. |
| D5 | Model output is strict JSON; Rust validates it and **drops any card whose quoted lines are not in the diff**. Line numbers are computed by Rust from the file, never trusted from the model. | Main pitfall from research: hallucinated explanations. |
| D6 | Cards are stored in a new **local-only** SQLite table `learn_cards`. Not synced. | No API contract change. Saved cards are the input for Plan 2 (spaced review). |
| D7 | Triggers: `terminal-finished` (auto) and a **"Learn from current changes"** button in the Learn tab (manual). | Interactive agent sessions often never exit, so manual is required. Idle-based auto trigger is out of scope for v1. |

## User experience

1. **Settings > Agents > Learn** (new page)
   - "Learn from agent changes" toggle (D1, default ON).
   - "Allow Learn to send the session diff to Claude" toggle (D2, default off), with the same
     disclosure style as External AI summaries: up to 24 KiB of diff, scrubbed, sent via your Claude CLI.
2. **Inspector Learn tab** (4th tab after Commands, icon `GraduationCap`), only when `learnEnabled`.
   - Count badge on the tab when unseen cards exist for the active terminal.
   - Header: session label, file summary, level switch Beginner / Intermediate / Expert (persisted, default Intermediate).
   - Card pills (1 Pattern, 2 System design, 3 Syntax).
   - Card: kind label, title, quoted code block with `file:start-end`, "why" text for the current level,
     predict question with 3 options, reveal on pick (correct / not quite + explanation).
   - Actions: Explain simpler, Go deeper (switch level), Save card, Next card.
   - Footer: "Generated with your Claude CLI. Quoted lines are checked against the diff."
   - States: no consent (Allow button), no changes ("No changes to learn from yet"), generating (skeleton),
     Claude CLI missing ("Learn needs Claude Code installed"), failed (Retry), cards.
3. **Terminal finished strip**: the existing `Terminal Finished` toast gets an *Open Learn* action when
   cards were produced. No modal, no sound, no focus change.
4. **Command palette**: "Learn: open", "Learn: generate from current changes" (only when enabled).

## Architecture

### Rust (`src-tauri/src/learn.rs`, new module)

```
learn.rs
  collect_diff(working_dir) -> Result<DiffBundle>          // git diff HEAD + untracked, capped 24 KiB, per-file
  build_prompt(goal, diff) -> String                        // fixed instructions + JSON schema
  parse_cards(stdout) -> Result<Vec<RawCard>>               // serde, tolerant of ```json fences
  verify_cards(raw, &DiffBundle, working_dir) -> Vec<LessonCard>  // D5 quote check + line numbers, max 3
#[command] get_learn_consent / set_learn_consent
#[command] generate_learn_cards(terminal_id) -> GenerateResult  // consent check first (Rust-owned)
#[command] list_learn_cards(terminal_id) -> Vec<LessonCard>
#[command] update_learn_card(id, saved?, answered_index?)
```

- `GenerateResult = { status: "ok" | "no_consent" | "no_changes" | "no_cards" | "in_progress" | "cli_missing" | "timeout" | "failed", cards }`.
  `no_cards` = the model answered but verification dropped every card; `in_progress` = a generation for that terminal is already running.
  Non-ok statuses are data for the UI, not `Err`, so expected outcomes do not pollute telemetry.
- Working directory resolved from the terminal config the same way `get_terminal_changes` does; repo root
  via `resolve_repo_root`. Paths validated with `validate_git_pathspec`.
- Diff text passes through `error_reporter::scrub` before leaving the process.
- Spawn: `shell_command("claude", ["-p", "--model", "haiku", <prompt>])`, diff piped on stdin, 60 s timeout.
- Concurrency: one generation per terminal at a time (in-flight set in `AppState` or a module-level
  `Mutex<HashSet<String>>`); a second request returns the in-flight status.

`LessonCard` (serde camelCase):

```
id: String (uuid)            terminalId: String         createdAt: String
kind: "pattern" | "system_design" | "syntax" | "concept"
title: String                filePath: String           startLine: u32   endLine: u32
quote: Vec<String>           highlight: Vec<u32>        // line numbers to highlight
why: [String; 3]             // beginner, intermediate, expert
question: String             options: [String; 3]       answerIndex: u8
explain: String              saved: bool                answeredIndex: Option<u8>
```

### Database (`database.rs`)

```sql
CREATE TABLE IF NOT EXISTS learn_cards (
  id TEXT PRIMARY KEY,
  terminal_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  file_path TEXT NOT NULL,
  card_json TEXT NOT NULL,
  saved INTEGER NOT NULL DEFAULT 0,
  answered_index INTEGER
);
CREATE INDEX IF NOT EXISTS idx_learn_cards_terminal ON learn_cards(terminal_id);
```

New generation for a terminal replaces that terminal's unsaved cards; saved cards are kept.
Not added to `sync_queue` (D6).

### Frontend

- `src/store/appStore.ts`: `learnEnabled: true`, `learnLevel: 1`, `learnOpen: false` + `toggleLearn`
  (mutually exclusive with `changesOpen` / `workspacesOpen` / `hintsOpen`), `setLearnEnabled`, `setLearnLevel`.
  Add `learnEnabled`, `learnLevel`, `learnOpen` to `partialize` and to `PERSISTED_KEYS` in `appStore.test.ts`.
  Turning `learnEnabled` off also closes `learnOpen`.
- `src/store/learnStore.ts` (new, not persisted): per-terminal `{ status, cards, unseen }`, actions
  `load(terminalId)`, `generate(terminalId)`, `markSeen`, `answer`, `toggleSave`.
- `src/components/learn/LearnPanel.tsx` (states + header), `LessonCard.tsx` (one card),
  `LearnConsent.tsx` (Allow block). Styling with existing tokens, no new colors.
- `src/components/Inspector.tsx`: add `'learn'` tab when `learnEnabled`.
- `src/App.tsx` `terminal-finished` handler: after the summary block, if `learnEnabled`, call
  `learnStore.generate(id)` (it checks consent through Rust; `no_consent` is silent).
- `src/components/settings/categories/LearnPage.tsx` + entry `{ id: 'learn', label: 'Learn' }` in the
  `claude` group of `settings/index.ts`, with `registerSetting` keywords (learn, tutor, lessons, education).
- Command palette entries guarded by `learnEnabled`.

## Error handling

- User-initiated generate / allow / save failures: `toast.error` + `reportInvokeFailure` (repo rule).
- Auto generation on `terminal-finished`: `.catch(() => {})` with a comment (best-effort background work),
  status shown in the tab only.
- Expected outcomes (no consent, no changes, CLI missing, timeout, all cards dropped by verification)
  return `GenerateResult.status`, never `Err`.
- Invalid JSON from the model: status `failed`, Retry button.

## Testing

- Rust unit tests in `learn.rs`:
  - `parse_cards` accepts plain JSON and fenced JSON, rejects wrong shapes.
  - `verify_cards` drops cards whose quotes are not in the diff, computes line numbers, caps at 3.
  - `collect_diff` caps size and skips binary files (temp git repo fixture, like existing git tests).
  - `generate_learn_cards` returns `no_consent` without spawning when consent is off.
  - DB round trip: insert, list, replace unsaved on regenerate, keep saved.
- Frontend (Vitest, jsdom):
  - `Inspector` shows the Learn tab only when `learnEnabled`.
  - `LessonCard`: options disabled after pick, correct/incorrect state, level switch changes "why" text.
  - `LearnPanel` renders each state from a mocked `GenerateResult`.
  - `LearnPage` toggles call `setLearnEnabled` and `set_learn_consent`.
  - `appStore.test.ts` persisted keys updated.
- Manual QA via `/qa`: run an agent that edits a file, generate cards, play a card, turn flag off.

## Out of scope (v1)

- Spaced review deck and progress view (Plan 2).
- Agent-steered `TODO(human)` exercises (Plan 3).
- Idle-based auto trigger, per-agent transcript parsing, syncing cards to the API.
- Telemetry beyond existing command error reporting. (A follow-up can add counts of cards generated /
  answered to the ct-analytics worker; that is a worker + desktop change.)
