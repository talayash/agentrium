# Custom Agents and API Keys - Design

**Date:** 2026-09-04
**Status:** Approved for planning (option 2 of the brainstorm, as scoped)
**Sketch:** https://claude.ai/code/artifact/19cd1d8b-6c8e-4112-a546-c0677c561920

## 1. Goal

Let a user extend Agentrium beyond the four built-in agents (Claude Code,
Codex, Cursor, Antigravity) in two ways:

1. **Local agent.** Register any coding-agent CLI on the machine (OpenCode,
   Gemini CLI, Aider, Goose, Qwen Code, or an arbitrary binary) so it shows
   up as a first-class tile in the agent picker, spawns through the same PTY
   path, and can resume sessions where the CLI supports it.
2. **API key.** Store provider credentials (Anthropic, OpenAI, Google,
   Cursor, OpenRouter, custom) in the OS credential store and inject them
   into an agent's process environment at launch, optionally with an
   endpoint override so Claude Code can run against Ollama, LiteLLM or a
   gateway.

Both are configured from one new settings page, **Agents & Keys**, and
surfaced in the New Session modal.

## 2. Non-goals

- Per-provider model catalogs or model badges for custom agents. The CLIs
  own their model lists; custom agents pass `--model` through untouched.
- Session-history parsing for custom agents. Custom agents get resume via a
  flag template only; the sessions panel shows nothing for them (same as
  Antigravity today).
- Syncing keys between machines. Keys live in the local OS store only.
- Replacing the built-in agents' hard-coded specs. They stay in
  `agents.rs` / `agents.ts`; custom agents are additive.

## 3. Research summary

- Conductor defaults to the CLI's existing login and offers an opt-in API
  key mode per harness. Vibe Kanban models agents as executor profiles with
  user overrides layered over shipped defaults. OpenCode never writes keys
  into config; they stay in env vars or a credential store. This design
  follows the same three rules: reuse CLI login by default, layer user
  entries over built-ins, never persist key values in app data.
- Every target CLI reads its key from one env var and most accept an
  endpoint override: Claude Code `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`,
  Codex `OPENAI_API_KEY`, Cursor `CURSOR_API_KEY`, Gemini CLI
  `GEMINI_API_KEY`. Env injection is therefore the complete integration
  surface.
- The `keyring` crate (v4) fronts Windows Credential Manager, macOS Keychain
  and Linux Secret Service. Tauri's Stronghold plugin is deprecated for v3.
- Today `profiles.env_vars` is stored as plaintext JSON in SQLite
  (`database.rs` `save_profile`). Any key typed into the Profile modal is
  unencrypted on disk. This design closes that gap.

## 4. User-facing behaviour

### 4.1 New Session modal

- **Agent picker** renders built-in specs followed by custom agents, then a
  dashed **Add agent** tile. Grid is `grid-cols-4` for up to 4 tiles and
  `grid-cols-3` for 5 or more (so 5-6 tiles fill two even rows). Custom
  tiles show a two-letter monogram in the agent's tint with a small
  `LOCAL` tag; built-ins keep their brand marks.
- **Authentication** section (new, below Agent) with a two-way segmented
  control:
  - **CLI login** (default): nothing injected. Identical to current
    behaviour.
  - **API key**: a row picker listing saved credentials whose env var is in
    the selected agent's `required_env` list (or any credential, for
    built-ins). Selecting one records `{env, credential_id}` on the
    request. The row shows label, env var name and the store name
    ("Windows Credential Manager" / "Keychain" / "Secret Service").
  - The section is hidden for plain shell.
- **Command preview** appends `· key injected at launch` in success colour
  when a credential is selected. Values never appear.
- **Add agent** tile opens the Add Agent dialog; on save the picker
  selects the new agent.

### 4.2 Add Agent dialog

Segmented header: **Local CLI** | **Hosted API (key only)**.

**Local CLI tab**

- **Start from** preset grid: OpenCode, Gemini CLI, Aider, Goose, Qwen
  Code, Custom binary. Picking a preset fills every field below; Custom
  binary clears them. Presets are a static table in `src/lib/agentPresets.ts`
  (name, binary, default args hint, resume template, tint, required env
  vars, install URL, install hint).
- **Display name** (required, 1-40 chars).
- **Command** (required). Binary name or absolute path. On change
  (debounced 400 ms) the UI calls `probe_binary` and shows one of:
  `Found <resolved path> · <version>`, `Found <resolved path>` (no
  parseable version), or `Not found on PATH` in warning colour. Not found
  does not block saving.
- **Default arguments** textarea, one per line, same validation as
  today's Claude args (shell metacharacters rejected server-side).
- **Resume flag** template. Two forms:
  - With `{id}` (e.g. `--session {id}`, `resume {id}`): used when a
    session id is known. `{id}` is the only placeholder and may appear
    once.
  - Without `{id}` (e.g. `--continue`, `-c`): used verbatim as the
    "continue most recent" flag when Agentrium restores a workspace after
    relaunch (`continue_recent`).
  Empty means the agent cannot resume and restore spawns it fresh. Helper
  text under the field explains both forms.
- **Tile colour**: six fixed swatches (success green, accent blue, warning
  orange, purple, pink, sky). Stored as a hex string from that set.
- **Credentials this agent needs**: list of env var names (from preset or
  added manually), each with a credential picker (`None` allowed). "Add
  another variable" appends a row. This list is the agent's
  `required_env`; the per-row selection is the agent's default credential
  binding, which the New Session modal uses when Authentication = API key
  and the user does not override it.
- Footer shows the resulting command line; **Add Agent** saves.

**Hosted API tab** switches the dialog body to the Add API Key form (4.3)
for users who only want to store a key without adding a CLI. Saving from
this tab creates a credential only.

### 4.3 Add API Key dialog

- **Provider** chips: Anthropic, OpenAI, Google, Cursor, OpenRouter,
  Custom. Picking one sets env var and endpoint variable defaults:

  | Provider   | Key env var          | Endpoint env var       | Default endpoint            |
  |------------|----------------------|------------------------|-----------------------------|
  | Anthropic  | `ANTHROPIC_API_KEY`  | `ANTHROPIC_BASE_URL`   | `https://api.anthropic.com` |
  | OpenAI     | `OPENAI_API_KEY`     | `OPENAI_BASE_URL`      | `https://api.openai.com/v1` |
  | Google     | `GEMINI_API_KEY`     | none                   | n/a                         |
  | Cursor     | `CURSOR_API_KEY`     | none                   | n/a                         |
  | OpenRouter | `OPENROUTER_API_KEY` | `OPENAI_BASE_URL`      | `https://openrouter.ai/api/v1` |
  | Custom     | user-typed           | user-typed or none     | user-typed                  |

- **Label** (required, unique, 1-40 chars).
- **Environment variable** (required, `^[A-Z_][A-Z0-9_]*$`, not in
  `BLOCKED_ENV_VARS`).
- **API key** field: password input with show/hide and paste buttons.
  May be left empty when an endpoint override is set (local Ollama needs
  no key). Either key or endpoint must be present.
- **Storage note** (static): "Saved to <store name>. Agentrium keeps only
  the label and variable name."
- **Endpoint override** disclosure (collapsed unless the provider has an
  endpoint var or a value is set): URL input for the endpoint env var.
  Must parse as `http` or `https` URL.
- **Test connection**: calls `test_credential`. Result line: success with
  the first model id returned and latency, or the HTTP status / error
  text. Test is best-effort; failure does not block saving.
- **Use as default for**: chips for every agent whose `required_env`
  contains this env var (built-ins included via their spec). Checked
  agents get this credential as their default binding.
- **Save Key** persists.

### 4.4 Settings → Agents & Keys

New settings group **Agents** with pages **Agents & Keys** (new) and
**Claude Code** (the existing `claude` group's two pages move under it; the
`claude.defaults` and `claude.updates` page ids are unchanged so
`registerSetting` keys keep working).

- **Agents** section: one row per built-in then custom agent. Columns:
  icon, name + kind badge (`Built in` / `Local CLI`), mono subline
  (`binary · version · key: <label>` or `needs <ENV>` or
  `not found on PATH`), status dot + word (Ready / No key / Missing),
  action link (Defaults for built-ins → existing pages; Edit for custom;
  Add key when a required env has no binding; Install when missing).
  **Add agent** button opens 4.2. Editing a custom agent opens 4.2
  prefilled with a **Delete agent** button in the footer (confirm inline,
  same pattern as profile delete).
- **API keys** section: one row per credential. Columns: key icon, label,
  mono subline (`ENV · masked value · used by <agents>`), last used
  relative time, **Remove**. Remove asks inline confirmation, deletes from
  the OS store, and clears every binding that referenced it.
  **Add key** opens 4.3.
- Status is computed on page open by calling `probe_binary` for each agent
  in parallel (results cached in component state for the page lifetime).

### 4.5 Profile modal

- The **Environment Variables** editor gains a per-row **Move to keychain**
  action for any row whose name matches `(_API_KEY|_TOKEN|_SECRET)$`. It
  opens 4.3 prefilled with env var and value, and on save removes the row
  from the profile and stores a binding on the profile instead.
- Profiles gain `credential_bindings: [{env, credential_id}]` so a profile
  can pin a key. New Session applies profile bindings when Authentication
  = API key and the user has not overridden the row.

### 4.6 Migration prompt

On the first launch after upgrade, if any saved profile has an env var
whose name matches the pattern above, show a one-time toast: "N profiles
store API keys as plain text. Move them to <store name>?" with **Review**
(opens Agents & Keys with those profiles listed) and **Not now**. The
prompt is recorded in `app_meta` so it shows once.

## 5. Architecture

### 5.1 Agent identity

`AgentKind` (Rust) and `AgentKind` (TS) grow a custom variant. Wire form
stays a plain string.

Rust (`config.rs`):

```rust
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum AgentKind {
    Claude, Codex, Cursor, Antigravity,
    Custom(String), // the custom_agents.id (uuid v4), stored as given
}
```

- `Copy` is dropped. The 140 existing uses are mostly `match` arms or
  `==` comparisons, which keep working; the handful of by-value moves take
  `.clone()`.
- Custom `Serialize`/`Deserialize` (string): built-ins keep their lowercase
  names; custom serialises as `custom:<id>`. `from_str_lossy` parses
  `custom:` prefixes and keeps the `gemini` → Antigravity legacy mapping.
  An unknown non-prefixed string still falls back to Claude.
- `as_str()` returns `Cow<'static, str>` (or a `String`) because the custom
  form is dynamic.

TypeScript (`agents.ts`):

```ts
export type BuiltinAgentKind = 'claude' | 'codex' | 'cursor' | 'antigravity';
export type AgentKind = BuiltinAgentKind | `custom:${string}`;
export function isCustomAgent(kind: AgentKind): kind is `custom:${string}`;
```

Every `Record<AgentKind, T>` that enumerates all kinds becomes
`Record<BuiltinAgentKind, T>` with a lookup helper that falls back for
custom kinds: `defaultAgentArgs`, `NO_VALUE_STRIP`, `WITH_VALUE_STRIP`,
`AGENT_MODELS`, `AGENT_TINT` (SessionCards), `agentVersions` (AboutPage).
Fallback rules:

- `filterArgsForAgent(custom)` uses the Cursor strip sets (drop
  Claude-only flags and `--model`/`--effort`/`--resume` pairs). Custom
  agents' own default args are appended after filtering, so a
  `--model` typed in the custom agent's defaults survives.
- `modelsForAgent(custom)` returns `[]`; the model chip row is hidden.
- Tint for custom kinds is the agent's stored colour.

### 5.2 Custom agent registry

New SQLite table (`database.rs`, created in `init` alongside the others):

```sql
CREATE TABLE IF NOT EXISTS custom_agents (
  id            TEXT PRIMARY KEY,   -- uuid v4
  name          TEXT NOT NULL,
  binary        TEXT NOT NULL,
  default_args  TEXT NOT NULL,      -- JSON array of strings
  resume_flag   TEXT,               -- e.g. "--session {id}", NULL = cannot resume
  color         TEXT NOT NULL,      -- hex from the fixed swatch set
  required_env  TEXT NOT NULL,      -- JSON array of env var names
  bindings      TEXT NOT NULL,      -- JSON array of {env, credential_id}
  install_url   TEXT,
  install_hint  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
```

New module `src-tauri/src/custom_agents.rs`:

- `pub struct CustomAgent { ... }` mirroring the table, `Serialize` +
  `Deserialize` for the wire.
- Validation on save: name length, binary non-empty and free of shell
  metacharacters (reuse `TerminalManager::SHELL_METACHARACTERS`), each
  default arg validated the same way `claude_args` are today, `resume_flag`
  may contain `{id}` at most once and is otherwise validated like an arg
  (or is null), `color` must be in the
  allowed set, each `required_env` name must match `^[A-Z_][A-Z0-9_]*$`
  and not be in `BLOCKED_ENV_VARS`. Violations return
  `error_reporter::user_err`.
- `AgentSpec` (in `agents.rs`) changes `binary`, `display_name`,
  `install_url`, `install_hint` from `&'static str` to `String`, and
  `spec_for(kind, db)` takes the DB handle so `Custom(id)` resolves from
  the table. A missing custom id returns a `user_err("Agent was removed")`
  rather than panicking; `create_terminal` surfaces that to the UI.

Commands (all in `commands.rs`, wrapped with `wrap_cmd`):

- `list_custom_agents() -> Vec<CustomAgent>`
- `save_custom_agent(agent: CustomAgent) -> CustomAgent` (insert or
  replace; generates id when empty)
- `delete_custom_agent(id: String)`
- `probe_binary(binary: String) -> BinaryProbe { found: bool,
  resolved_path: Option<String>, version: Option<String> }`. Extracts the
  two-stage logic out of `get_agent_version` so both share it. Binary is
  validated against shell metacharacters first; the probe runs through the
  existing `shell_command` helper with `CREATE_NO_WINDOW`.

Spawn path (`terminal.rs`):

- `build_agent_command(spec: &AgentSpec, args)` takes the resolved spec
  instead of a kind.
- `resume_flags_for` takes the resolved spec's `resume_flag` template for
  custom kinds:
  - `(Custom, Some(id))` with a template containing `{id}`: substitute,
    split on whitespace, and treat a leading non-flag token (e.g.
    `resume`) as a subcommand like Codex.
  - `(Custom, None)` with `continue_recent` and a template **without**
    `{id}`: inject the template verbatim (split on whitespace).
  - Any other combination (no template, or a `{id}` template with no id):
    empty injection, spawn fresh.
- OTel env injection stays Claude-only.

Session provider: `provider_for(AgentKind::Custom(_))` returns the
existing no-op provider, so no session id is captured for custom agents in
v1. The practical resume path is therefore the `continue_recent` form on
workspace restore. The `{id}` form is stored and honoured so a future
provider can light it up without a schema change.

### 5.3 Credentials

New module `src-tauri/src/credentials.rs` backed by the `keyring` crate
(v4, features `windows-native-keyring-store`,
`apple-native-keyring-store`, `dbus-secret-service-keyring-store`).

Service name: `com.claudeterminal.agentrium`. Entry user name:
`cred:<credential_id>` for the key value, `cred:<credential_id>:endpoint`
for the endpoint override. Two entries keep Windows' per-blob size limit
comfortable and let a credential hold only an endpoint.

Metadata (never the value) lives in SQLite:

```sql
CREATE TABLE IF NOT EXISTS credentials (
  id            TEXT PRIMARY KEY,   -- uuid v4
  label         TEXT NOT NULL UNIQUE,
  provider      TEXT NOT NULL,      -- anthropic|openai|google|cursor|openrouter|custom
  env_name      TEXT NOT NULL,      -- key env var
  endpoint_env  TEXT,               -- endpoint env var, NULL when none
  has_key       INTEGER NOT NULL,   -- 1 when a key value is stored
  masked_tail   TEXT,               -- last 4 chars of the key, for display
  created_at    TEXT NOT NULL,
  last_used_at  TEXT
);
```

Commands:

- `list_credentials() -> Vec<CredentialMeta>` (metadata only).
- `save_credential(meta: CredentialMeta, key: Option<String>,
  endpoint: Option<String>) -> CredentialMeta`. Writes value(s) to the OS
  store first, then upserts metadata. `key: None` on an existing
  credential keeps the stored value (the UI sends `None` when the masked
  field was not edited). Empty-string key deletes the stored key entry.
  Validation: label unique, env names valid and not blocked, endpoint
  parses as http(s) URL, at least one of key/endpoint present.
- `delete_credential(id)`. Removes both OS entries (ignoring not-found),
  deletes the row, and strips `{credential_id}` bindings from
  `custom_agents.bindings`, `profiles.credential_bindings_json`, and the
  built-in defaults table (5.4).
- `test_credential(id, provider) -> TestResult { ok, detail, latency_ms }`.
  Reads the value from the OS store in Rust and issues one GET using the
  existing `reqwest` client: Anthropic and Anthropic-compatible endpoints
  `GET {base}/v1/models` with `x-api-key` and `anthropic-version`;
  OpenAI-compatible `GET {base}/models` with `Authorization: Bearer`;
  Google `GET https://generativelanguage.googleapis.com/v1beta/models?key=`;
  Cursor returns `ok: false, detail: "No test endpoint; saved anyway"`.
  `detail` on success is the first model id. 8 s timeout. Failures are
  `user_err` (environment, not a bug).
- `resolve_credential_for_spawn` is internal (not a command): given
  bindings `[{env, credential_id}]`, reads each value from the OS store
  and returns `HashMap<String, String>` of env additions, updating
  `last_used_at`. Missing store entry → `user_err("Key '<label>' is no
  longer in <store>. Re-enter it in Agents & Keys.")`, and the spawn is
  aborted before the PTY starts.

`CreateTerminalRequest` gains `#[serde(default)] credential_bindings:
Vec<CredentialBinding>`. `create_terminal` resolves them, merges into
`env_vars` (bindings win over profile env vars with the same name), then
calls `TerminalManager::create_terminal` exactly as today. `BLOCKED_ENV_VARS`
filtering still applies afterwards. `TerminalConfig.env_vars` (returned to
the frontend and stored for session restore) **excludes** resolved
credential values: the config stores the bindings instead, and restore
re-resolves them. This keeps key values out of `TerminalConfig`,
workspaces, and session-history rows.

Redaction: `error_reporter.rs` already strips common secret shapes from
telemetry. Add the env var names from `credentials.env_name` to the
redaction list at runtime so an error message that echoes the environment
cannot leak a value.

### 5.4 Default bindings for built-ins

Built-ins have no `custom_agents` row, so their default credential
binding lives in a small `agent_defaults` table (`agent TEXT PRIMARY KEY,
bindings TEXT NOT NULL`). `get_agent_bindings(kind)` /
`set_agent_bindings(kind, bindings)` read and write it for any kind;
custom kinds route to `custom_agents.bindings`. The "Use as default for"
chips in 4.3 write through this pair.

### 5.5 Frontend structure

New or changed files:

- `src/lib/agents.ts`: `AgentKind` union, `isCustomAgent`,
  `BuiltinAgentKind`, `specFor` reading from a merged list, Cursor-style
  strip fallback for custom kinds.
- `src/lib/agentPresets.ts`: static preset table.
- `src/lib/credentials.ts`: typed wrappers for the credential commands and
  the `CredentialBinding` type.
- `src/store/agentRegistryStore.ts` (Zustand, not persisted): custom
  agents, credentials metadata, agent defaults, probe cache; `refresh()`
  loads all three lists in parallel. Terminal creation and both modals read
  from it.
- `src/components/AgentPicker.tsx`: merged list + Add tile; monogram
  rendering via `BrandIcon` fallback (`BrandIcon` accepts `{kind, color,
  monogram}` and renders a tinted rounded square for custom kinds).
- `src/components/AddAgentModal.tsx`, `src/components/AddApiKeyModal.tsx`.
- `src/components/NewTerminalModal.tsx`: Authentication section, passes
  `credential_bindings` on create, hides model chips for custom agents.
- `src/components/ProfileModal.tsx`: Move-to-keychain action,
  `credential_bindings` field.
- `src/components/settings/categories/AgentsKeysPage.tsx`; settings index
  gains the `agents` group and moves the `claude` pages under it.
- `src/store/appStore.ts`: `defaultAgentArgs` becomes
  `Record<BuiltinAgentKind, string[]>`; custom agents' defaults come from
  their registry row.
- `src/components/WelcomeScreen.tsx`: cards render from the merged list so
  a custom agent appears on the welcome screen too.

### 5.6 Data flow: starting a session with a key

1. User picks agent `custom:abc`, Authentication = API key, credential
   "Work OpenAI" for `OPENAI_API_KEY`.
2. Frontend builds `CreateTerminalRequest { agent: "custom:abc", claude_args,
   env_vars (profile), credential_bindings: [{env: "OPENAI_API_KEY",
   credential_id: "..."}] }`.
3. `create_terminal` resolves the spec from `custom_agents`, resolves
   bindings from the OS store, merges env, validates, spawns
   `opencode <args>` via the PTY with the merged env.
4. `TerminalConfig` returned to the UI carries `credential_bindings`, not
   values. Session restore replays step 3.

## 6. Error handling

- All validation failures are `user_err` and surface as the modal's
  inline error text (same slot the New Session modal uses today).
- OS store unavailable (Linux without Secret Service, locked keychain):
  `save_credential` fails with a `user_err` naming the store and the
  Agents & Keys page shows a persistent banner "Credential store
  unavailable: <reason>". No plaintext fallback is offered.
- Binary missing at spawn: the PTY spawn already reports the OS error; the
  message is prefixed with the agent's install hint when one exists (same
  as built-ins).
- Custom agent deleted while a profile still references it: the profile
  row's `agent` falls back to Claude on load via `from_str_lossy`, and the
  Profile modal shows "Agent removed" next to the picker until re-saved.
- Credential deleted while an agent still binds it: bindings are cleaned
  in the same transaction as the delete (5.3), so this state cannot persist.

## 7. Security notes

- Key values touch four places only: the WebView input field at entry
  time, the one `save_credential` IPC call that carries it to Rust, the OS
  credential store, and Rust memory during `resolve_credential_for_spawn`
  on the way into the child process environment. Rust never returns a
  value to the WebView, and values never enter SQLite, `TerminalConfig`,
  workspace JSON, session logs, or telemetry.
- `probe_binary` and `save_custom_agent` reject shell metacharacters so a
  crafted binary string cannot become a shell injection through
  `cmd /C` / `sh -c`.
- `BLOCKED_ENV_VARS` applies to credential env names at save time and to
  the merged env at spawn time.
- The Windows `where` probe and `--version` run with `CREATE_NO_WINDOW` as
  today.

## 8. Testing

Rust (`cargo test`):

- `config.rs`: round-trip serde for every built-in and for
  `Custom("abc")` → `"custom:abc"`; `from_str_lossy` on `custom:`,
  `gemini`, and garbage.
- `custom_agents.rs`: validation table tests (metacharacters, blocked env,
  bad colour, `{id}` count).
- `terminal.rs`: `resume_flags_for(Custom)` with `--session {id}`,
  `resume {id}` (subcommand form), `--continue` under `continue_recent`,
  a `{id}` template with no id (empty), and null template;
  `build_agent_command` with a custom spec.
- `credentials.rs`: unit tests behind a `MockStore` trait implementation
  so CI does not need a real keychain; one ignored integration test that
  hits the real store locally.
- `database.rs`: `delete_credential` strips bindings from all three
  tables.

TypeScript (`vitest run`):

- `agents.test.ts`: `isCustomAgent`, `filterArgsForAgent` for a custom
  kind (Cursor fallback), merged `specFor`.
- `agentPresets.test.ts`: every preset has a binary, tint from the allowed
  set, and env names matching the regex.
- `agentRegistryStore.test.ts`: refresh merges lists; delete clears
  bindings locally.
- `NewTerminalModal` behaviour test: selecting API key mode adds
  `credential_bindings` to the invoke payload and never includes a value.
- `settings/index.test.ts`: `claude.defaults` and `claude.updates` still
  resolve after the group move.

Manual checklist before release: add OpenCode via preset on Windows, save an
Anthropic key, run Claude Code against Ollama via endpoint override, remove
the key and confirm the agent row flips to "No key", uninstall the binary
and confirm "Missing".

## 9. Rollout

- Version bump per `/publish`. Changelog entry under "Agents".
- Migration prompt (4.6) fires once. No destructive migration: existing
  profiles keep working unchanged until the user moves keys.
- `keyring` adds three platform features to `Cargo.toml`; CI already builds
  on Windows and both macOS targets, so the release workflow needs no
  change.
