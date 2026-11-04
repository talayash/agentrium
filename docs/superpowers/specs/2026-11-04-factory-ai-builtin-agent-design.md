# Factory AI (droid) Built-in Agent - Design

**Date:** 2026-11-04
**Status:** Approved for planning (full-parity built-in: real session restore, fork, curated model catalog)

## 1. Goal

Add Factory AI's **`droid`** CLI as a fifth first-class built-in agent in
Agentrium, alongside Claude Code, Codex, Cursor and Antigravity. It must
appear in the agent picker out of the box for all users and reach full
parity with the existing built-ins:

- Spawn through the same PTY path with an initial prompt (Race mode / New
  Task) delivered via argv.
- Resume a specific session, continue the most recent one, and **fork** a
  conversation.
- List and detect on-disk sessions (Sessions panel / Resume picker).
- Pick a model from a curated catalog with a brand-tinted badge.
- Carry a Factory brand icon in every surface that shows an agent mark.

## 2. Non-goals

- **Factory cloud / API / SDK integration.** This is CLI-only. The Factory
  TypeScript/Python SDKs and `droid exec` headless mode are out of scope.
- **Changelog / What's New copy and the version bump.** Those belong to the
  `/publish` flow and are handled separately when the feature ships.
- **Model catalog auto-sync.** The `factory` catalog in `agentModels.ts` is
  hand-curated like every other agent's; it is not fetched from `droid`.
- **Syncing anything Factory-specific between machines.** Nothing new is
  added to the sync row; Factory is a built-in like the others.

## 3. Research summary

All facts below are verified against Factory's own docs
(`docs.factory.ai` / `docs.factory.com`, Nov 2026) except the session
on-disk encoding, which is flagged for verification in section 7.

- **Binary:** `droid`.
- **Install:** `curl -fsSL https://app.factory.ai/cli | sh` (macOS/Linux),
  `irm https://app.factory.ai/cli/windows | iex` (Windows); also
  `npm install -g droid`.
- **Initial prompt:** positional - `droid "query"` ("Start REPL with
  initial prompt"). Maps to `InitialPrompt::Positional`, same as Claude and
  Codex.
- **Resume:** `droid --resume [sessionId]` (alias `-r`); the id is
  optional and, when omitted, resumes the last-modified session.
- **Fork:** `droid --fork <sessionId>` - "Fork and resume a session in a
  new copy."
- **Model:** `droid --model <id>` / `-m <id>`; accepts concrete ids (e.g.
  `claude-opus-5-5`) and provider-tier aliases such as
  `openai-latest-balanced` that track Factory's recommended model per
  provider/tier as new models ship.
- **Sessions on disk:** one conversation per `<id>.jsonl` under
  `~/.factory/sessions/-<cwd-dashed>/`, beside a `<id>.settings.json`
  sidecar. The state root honors `FACTORY_HOME_OVERRIDE` (Droid appends
  `.factory`), default `~/.factory`. This is a Claude-like JSONL-per-cwd
  layout, so `ClaudeSessionProvider` is the model to follow. The exact
  `-<cwd-dashed>` encoding comes from a community source and must be
  verified against a real install before the provider is finalized.

## 4. User-facing behaviour

- **Agent picker** (New Session / New Task / Race / Handoff): a Factory
  tile appears among the built-ins with its brand icon and name "Factory".
- **Model picker:** selecting Factory shows a single chip row of curated
  models; the chosen alias is injected as `--model <alias>` after arg
  filtering (same mechanism as Codex/Cursor/Antigravity).
- **Initial prompt:** in Race / New Task, the task text is appended to argv
  as a positional argument (byte-for-byte safe path) or written to a prompt
  file and passed as "Read the task description in <file>" - the existing
  `render_initial_prompt` logic, no new code.
- **Resume / Continue / Fork:** the Sessions panel lists past Factory
  sessions for the cwd; Resume launches `droid --resume <id>`, Continue
  launches `droid -r`, and Fork launches `droid --fork <id>`. Fork buttons
  are enabled for Factory (parity with Claude/Codex).
- **Badges:** tab strip and status bar show the Factory brand tint and the
  model badge.

## 5. Architecture - backend (Rust)

### 5.1 `config.rs`
- Add `AgentKind::Factory` with wire form `"factory"` (serde rename
  consistent with the existing variants). Include it anywhere the variant
  set is enumerated for round-trip tests.

### 5.2 `agents.rs`
- Add a `builtin_spec(Factory)` arm:
  - display_name `"Factory"`, binary `"droid"`,
  - install_url `"https://docs.factory.ai/cli"`,
  - install_hint `"curl -fsSL https://app.factory.ai/cli | sh"`,
  - `.with_initial_prompt(InitialPrompt::Positional)` (verified).
- Add `AgentKind::Factory` to `all_builtin_specs()` (the count test rises
  from 4 to 5; add a `factory_spec_has_droid_binary` test and an
  `initial_prompt` assertion mirroring the others).

### 5.3 `terminal.rs`
- `resume_flags_for` new arms:
  - `(Factory, Some(id))` -> `leading: ["--resume", id]`, no subcommand.
  - `(Factory, None) if continue_recent` -> `leading: ["-r"]`.
    The `-r` alias is used deliberately: bare `--resume` with no id can
    swallow the following injected flag as its optional `[sessionId]`, so
    `-r` avoids that ambiguity.
  - Fork path: `(Factory, Some(id))` with `fork` -> `leading: ["--fork", id]`.
- Add `AgentKind::Factory` to `supports_fork`.
- Add tests mirroring the existing per-agent resume/continue/fork tests
  (`resume_for_factory_uses_resume_flag`, `continue_for_factory_uses_r`,
  `fork_for_factory_uses_fork_flag`, `supports_fork` includes Factory).
- No change needed to `CMD_UNSAFE` / `render_initial_prompt`; positional
  prompt reuses the Claude/Codex path.

### 5.4 `factory_session.rs` (new) + `session_provider.rs`
- New `FactorySessionProvider` modeled on `ClaudeSessionProvider`:
  - `snapshot()` / `find_new_for_cwd()` / `list_for_cwd()` over
    `~/.factory/sessions/-<cwd-dashed>/*.jsonl`, honoring
    `FACTORY_HOME_OVERRIDE`.
  - Preview derived from the first/last user message in the `.jsonl`
    (exact field verified against a real session file).
  - `<id>.settings.json` sidecars are ignored when listing ids.
- `provider_for(AgentKind::Factory)` returns the new provider (replaces the
  NoOp arm Factory would otherwise fall into).

## 6. Architecture - frontend (TS)

### 6.1 `agents.ts`
- Add `'factory'` to `BuiltinAgentKind` and `BUILTIN_AGENT_KINDS`.
- Add an `AGENT_SPECS` entry: binary `droid`, install url/hint as above,
  `initialPrompt: true`, a `defaultArgsHint` (autonomy/model left to
  verification; keep minimal and verified rather than guessed).
- Add `factory` keys to `NO_VALUE_STRIP` and `WITH_VALUE_STRIP` with the
  same strip sets as cursor/antigravity (`--dangerously-skip-permissions`,
  `--worktree`; value-pairs `--model`, `--effort`, `--resume`).
- Adding the union member makes `tsc` flag every remaining
  `Record<BuiltinAgentKind, T>` that needs a Factory entry - that compiler
  error list is the authoritative to-do for the frontend wiring.

### 6.2 `agentModels.ts`
- `AGENT_MODELS` is `Record<Exclude<BuiltinAgentKind,'claude'>, ...>`, so a
  `factory` array is required by the type. Seed it with provider-tier
  aliases (`openai-latest-balanced` and the anthropic/google tier
  equivalents) plus headliners like `claude-opus-5-5`. Reuse existing
  vendor tints (OPENAI/SONNET/OPUS/GEMINI); add a `FACTORY` tint only if a
  Factory-native model is listed. Finalize the alias list against
  `droid --model` / the `/models` page at implementation time.

### 6.3 `BrandIcon.tsx`
- Add a `FactoryMark` component (original mark, `currentColor`) and a
  `case 'factory'` returning it with a Factory brand tint.

## 7. Verification plan

- **Implementation gate (RED first):** before finalizing
  `FactorySessionProvider`, write a test pinned to a real session fixture
  captured from a `droid` install, confirming the `-<cwd-dashed>` directory
  encoding and the preview field. Do not ship the provider against the
  community-sourced path assumption alone.
- **`verification-loop`:** full build + typecheck + lint + Rust and TS test
  suites.
- **`security-review`:** the new PTY-spawned binary (`droid`) and the new
  filesystem read path (`~/.factory/sessions`) pass the Tauri spawn /
  path-handling checklist (no shell interpolation of the cwd, credentials
  stripped from any surfaced paths).
- **Manual QA (`local-qa`):** spawn a Factory terminal; confirm (a) initial
  prompt lands, (b) the Sessions panel lists sessions for the cwd, (c)
  Resume, Continue (`-r`) and Fork each relaunch correctly, (d) model badge
  and brand icon render in tab strip and status bar.

## 8. Known edges

- `droid --resume` with no id can consume a following flag as the optional
  `[sessionId]`; the `-r` alias for continue-recent avoids this. Tests pin
  the injected arg order.
- Provider-tier aliases change meaning over time by design; that is
  acceptable (the user opted into tier aliases). Concrete ids in the
  catalog may go stale and are a maintenance item, not a correctness bug.
- `FACTORY_HOME_OVERRIDE` must be honored in the provider so a relocated
  state root still lists sessions.
