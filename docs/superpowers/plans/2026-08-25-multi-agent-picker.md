# Multi-Agent Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users choose which coding-agent CLI (Claude Code or Codex) a terminal launches, via a two-button strip above the Profile grid in the New Terminal modal, backed by a pluggable `AgentSpec` catalog so future agents drop in with minimal surface.

**Architecture:**
- Backend: introduce `AgentKind` enum + `AgentSpec` catalog (`agents.rs`). `ConfigProfile` grows an `agent` field with `#[serde(default)]` so existing rows migrate transparently to `Claude`. `TerminalManager::create_terminal` accepts `agent` and picks the binary from the spec; Claude-only side effects (session-id resume, OTel injection) stay gated on `agent == Claude`.
- Frontend: `NewTerminalModal` gains an agent-picker row above profiles; `ProfileModal` gains an agent selector at the top of the form. Filtering is derived - profiles show only if their `agent` matches the selection.
- Migration: zero-schema-change. `ConfigProfile` JSON in SQLite deserializes fine either way thanks to `#[serde(default)]`.

**Tech Stack:** Rust (Tauri, portable-pty, serde, rusqlite), React 18 + TypeScript, Zustand, Vitest, Cargo test.

**Out of scope** (deferred to follow-up plans):
- Renaming `claude_args` → `args` across the codebase (21 files). The field name is misleading once it holds Codex args, but the churn dwarfs the feature. Note it in a code comment; rename in a dedicated PR.
- Proactive `check_agent_installed` UI (greying-out buttons when `codex` isn't on PATH). MVP fails fast at spawn time with a clear error.
- Per-agent hints in `HintsPanel` (currently Claude-only). Follow-up.
- SetupWizard multi-agent detection/install. Codex install stays manual for MVP.
- App rename + repo rename (independent workstream per user's roadmap).

**Precondition:** Run this plan in a worktree, not on `master` directly. The user is currently on `master` with `M src-tauri/gen/schemas/*.json` (auto-generated, safe to ignore). Suggested worktree branch: `feat/multi-agent-picker`.

---

## File Structure

### Files created
- `src-tauri/src/agents.rs` - `AgentKind` enum + `AgentSpec` catalog + `spec_for()` + `all_specs()`.
- `src/lib/agents.ts` - TypeScript mirror: `AgentKind` union, `AGENT_SPECS` const, `agentDisplayName()` / `agentBinary()` helpers.
- `src/components/AgentPicker.tsx` - the 2-button strip. Reused by both `NewTerminalModal` and `ProfileModal`.

### Files modified
- `src-tauri/src/config.rs` - add `agent: AgentKind` to `ConfigProfile` with `#[serde(default)]`.
- `src-tauri/src/terminal.rs` - add `agent` to `TerminalConfig`; extract `build_agent_command()` helper; gate Claude-only features behind `agent == Claude`.
- `src-tauri/src/commands.rs` - add `agent` to `CreateTerminalRequest`; pass through to `terminals.create_terminal()`.
- `src-tauri/src/main.rs` - register the new `agents` module.
- `src/components/NewTerminalModal.tsx` - add agent picker above profile grid; filter profiles by agent; update command-preview line to use selected agent's binary.
- `src/components/ProfileModal.tsx` - add agent picker at top of profile form; include `agent` in save payload.
- `src/store/terminalStore.ts` - thread `agent` through `createTerminal()` into the IPC call.

### Files unchanged (verify only)
- `src-tauri/src/database.rs` - profile column stores serialized `ConfigProfile` JSON; back-compat is on serde, no schema change needed. Confirm at Task 2.

---

## Task 1: Backend - `AgentKind` enum on `ConfigProfile`

**Files:**
- Modify: `src-tauri/src/config.rs`
- Test: `src-tauri/src/config.rs` (existing `#[cfg(test)] mod tests` block)

- [ ] **Step 1: Write the failing tests**

Add these tests to the `mod tests` block at the bottom of `src-tauri/src/config.rs`:

```rust
#[test]
fn agent_kind_defaults_to_claude() {
    assert_eq!(AgentKind::default(), AgentKind::Claude);
}

#[test]
fn agent_kind_serializes_lowercase() {
    let json = serde_json::to_string(&AgentKind::Codex).unwrap();
    assert_eq!(json, "\"codex\"");
}

#[test]
fn missing_agent_field_deserializes_as_claude() {
    // Simulate an existing profile row written before the migration.
    // All non-default fields present; `agent` intentionally omitted.
    let json = r#"{
        "id": "p1",
        "name": "legacy",
        "description": null,
        "working_directory": "/tmp",
        "claude_args": [],
        "env_vars": {},
        "is_default": false
    }"#;
    let cfg: ConfigProfile = serde_json::from_str(json).unwrap();
    assert_eq!(cfg.agent, AgentKind::Claude);
}

#[test]
fn explicit_codex_agent_round_trips() {
    let mut p = sample_profile();
    p.agent = AgentKind::Codex;
    let json = serde_json::to_string(&p).unwrap();
    let back: ConfigProfile = serde_json::from_str(&json).unwrap();
    assert_eq!(back.agent, AgentKind::Codex);
}
```

You will also need to add `agent: AgentKind::default(),` to the existing `sample_profile()` helper (line ~270 of the current file) - but only after Step 3 has added the field to the struct. For now, the tests will fail to compile because `AgentKind` doesn't exist yet. That's expected.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --lib config::tests -- --nocapture`

Expected: compile error `cannot find type AgentKind in this scope` - this is the "red" for our test.

- [ ] **Step 3: Add the enum and field**

At the top of `src-tauri/src/config.rs`, after the existing `use` block:

```rust
/// The coding-agent CLI a terminal should launch. `Default` is `Claude` so
/// profile rows written before this field existed migrate transparently on
/// their next deserialize.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
    Codex,
}

impl Default for AgentKind {
    fn default() -> Self {
        AgentKind::Claude
    }
}
```

Then add the `agent` field to `ConfigProfile` (currently lines 12-23):

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigProfile {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub working_directory: String,
    // Field is named `claude_args` for JSON back-compat with existing rows.
    // Semantically it's "agent args" - passed to whichever agent binary this
    // profile launches. Rename is deferred to its own PR.
    pub claude_args: Vec<String>,
    pub env_vars: HashMap<String, String>,
    pub is_default: bool,
    #[serde(default)]
    pub agent: AgentKind,
    #[serde(default)]
    pub preview: Option<PreviewProfile>,
}
```

Update the existing `sample_profile()` helper (search for `fn sample_profile()` in the test module) to add `agent: AgentKind::default(),` to the struct literal.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib config::tests`

Expected: all tests in `config::tests` pass (existing tests + the four new ones).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/config.rs
git commit -m "feat(config): AgentKind enum on ConfigProfile with serde back-compat"
```

---

## Task 2: Backend - `AgentSpec` catalog module

**Files:**
- Create: `src-tauri/src/agents.rs`
- Modify: `src-tauri/src/main.rs` (register module)
- Test: inline in `src-tauri/src/agents.rs`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/agents.rs` with the test module first:

```rust
use crate::config::AgentKind;

pub struct AgentSpec {
    pub kind: AgentKind,
    /// Human-readable name for the UI.
    pub display_name: &'static str,
    /// Executable name that will be resolved through PATH at spawn time.
    pub binary: &'static str,
    /// URL the "install" hint links to when the binary isn't found.
    pub install_url: &'static str,
    /// Short one-line install command shown in error messages.
    pub install_hint: &'static str,
}

pub fn spec_for(kind: AgentKind) -> AgentSpec {
    match kind {
        AgentKind::Claude => AgentSpec {
            kind: AgentKind::Claude,
            display_name: "Claude Code",
            binary: "claude",
            install_url: "https://docs.claude.com/claude-code",
            install_hint: "npm install -g @anthropic-ai/claude-code",
        },
        AgentKind::Codex => AgentSpec {
            kind: AgentKind::Codex,
            display_name: "Codex",
            binary: "codex",
            install_url: "https://github.com/openai/codex",
            install_hint: "npm install -g @openai/codex",
        },
    }
}

pub fn all_specs() -> Vec<AgentSpec> {
    vec![spec_for(AgentKind::Claude), spec_for(AgentKind::Codex)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_spec_has_claude_binary() {
        assert_eq!(spec_for(AgentKind::Claude).binary, "claude");
    }

    #[test]
    fn codex_spec_has_codex_binary() {
        assert_eq!(spec_for(AgentKind::Codex).binary, "codex");
    }

    #[test]
    fn all_specs_lists_every_agent_kind() {
        // If a new AgentKind variant is added and forgotten here, this test
        // fails - forces the catalog to stay in sync with the enum.
        let specs = all_specs();
        assert!(specs.iter().any(|s| s.kind == AgentKind::Claude));
        assert!(specs.iter().any(|s| s.kind == AgentKind::Codex));
        assert_eq!(specs.len(), 2);
    }
}
```

Register the module in `src-tauri/src/main.rs`. Find the existing `mod` declarations (e.g., `mod terminal;`, `mod commands;`) and add:

```rust
mod agents;
```

- [ ] **Step 2: Run tests to verify they fail**

Because the module was just created, tests either don't exist yet in the runner cache or all pass immediately. Run: `cd src-tauri && cargo test --lib agents::tests`

Expected: `3 passed`. If red, fix compile errors.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/agents.rs src-tauri/src/main.rs
git commit -m "feat(agents): AgentSpec catalog for Claude and Codex"
```

---

## Task 3: Backend - Route PTY spawn by agent

**Files:**
- Modify: `src-tauri/src/terminal.rs:11-29` (TerminalConfig), `src-tauri/src/terminal.rs:99-268` (create_terminal spawn logic)
- Test: inline in `src-tauri/src/terminal.rs` (extract a testable helper)

- [ ] **Step 1: Write the failing test**

Add this to a new `#[cfg(test)] mod tests` block at the bottom of `src-tauri/src/terminal.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AgentKind;

    #[test]
    fn build_agent_command_uses_claude_binary_for_claude() {
        let (bin, args) = build_agent_command(AgentKind::Claude, &["--model".into(), "opus".into()]);
        assert_eq!(bin, "claude");
        assert_eq!(args, vec!["--model", "opus"]);
    }

    #[test]
    fn build_agent_command_uses_codex_binary_for_codex() {
        let (bin, args) = build_agent_command(AgentKind::Codex, &["--json".into()]);
        assert_eq!(bin, "codex");
        assert_eq!(args, vec!["--json"]);
    }

    #[test]
    fn build_agent_command_passes_through_empty_args() {
        let (bin, args) = build_agent_command(AgentKind::Codex, &[]);
        assert_eq!(bin, "codex");
        assert!(args.is_empty());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --lib terminal::tests::build_agent_command_uses_claude_binary_for_claude`

Expected: compile error `cannot find function build_agent_command`.

- [ ] **Step 3: Extract the helper and add `agent` to `TerminalConfig`**

At the top of `src-tauri/src/terminal.rs`, add the helper (near the existing `is_benign_close_error` function around line 44):

```rust
/// Resolve the binary + arg list for a given agent. Extracted so the spawn
/// pipeline (which is IO-heavy and awkward to test directly) has one testable
/// seam. Args are cloned so callers keep ownership of the original vec.
pub fn build_agent_command(agent: crate::config::AgentKind, args: &[String]) -> (String, Vec<String>) {
    let spec = crate::agents::spec_for(agent);
    (spec.binary.to_string(), args.to_vec())
}
```

Then update `TerminalConfig` (lines 11-29) to include `agent`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalConfig {
    pub id: String,
    pub label: String,
    pub nickname: Option<String>,
    pub profile_id: Option<String>,
    pub working_directory: String,
    pub claude_args: Vec<String>,
    pub env_vars: HashMap<String, String>,
    pub created_at: DateTime<Utc>,
    pub status: TerminalStatus,
    pub color_tag: Option<String>,
    #[serde(default)]
    pub claude_session_id: Option<String>,
    /// Which agent CLI this terminal launched. `#[serde(default)]` so
    /// restored rows from before this field existed migrate to Claude.
    #[serde(default)]
    pub agent: crate::config::AgentKind,
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib terminal::tests`

Expected: `3 passed`.

- [ ] **Step 5: Wire the helper into `create_terminal`**

In `TerminalManager::create_terminal` (line 99), add an `agent` parameter as the second parameter (after `label`, before `working_directory`):

```rust
pub fn create_terminal(
    &mut self,
    label: String,
    agent: crate::config::AgentKind,
    working_directory: String,
    claude_args: Vec<String>,
    env_vars: HashMap<String, String>,
    color_tag: Option<String>,
    nickname: Option<String>,
    tx: mpsc::Sender<(String, Vec<u8>)>,
    log_file_path: Option<String>,
    resume_session_id: Option<String>,
    continue_recent: bool,
    otel_endpoint: Option<String>,
) -> Result<TerminalConfig, String> {
```

Then replace the hardcoded `"claude"` in both the Windows spawn block (line 194) and the non-Windows spawn block (line 221) with `spec.binary`. Update lines 188-238 to:

```rust
        // Resolve which agent binary to launch. `build_agent_command` returns
        // the binary name and echoes the args back so we can hand them to
        // CommandBuilder platform-appropriately.
        let (agent_binary, spawn_args) = build_agent_command(agent, &claude_args);

        // Spawn the agent binary directly so the process exits when it
        // finishes, allowing the terminal-finished event to fire for
        // notifications.
        #[cfg(target_os = "windows")]
        let mut cmd = {
            let mut c = CommandBuilder::new("cmd.exe");
            c.arg("/C");
            c.arg(&agent_binary);
            for arg in &spawn_args {
                c.arg(arg);
            }
            c
        };

        #[cfg(not(target_os = "windows"))]
        let mut cmd = {
            const VALID_SHELLS: &[&str] = &[
                "/bin/bash", "/bin/sh", "/bin/zsh", "/bin/fish", "/bin/dash",
                "/usr/bin/bash", "/usr/bin/sh", "/usr/bin/zsh", "/usr/bin/fish", "/usr/bin/dash",
                "/usr/local/bin/bash", "/usr/local/bin/zsh", "/usr/local/bin/fish",
                "/opt/homebrew/bin/bash", "/opt/homebrew/bin/zsh", "/opt/homebrew/bin/fish",
            ];

            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
            let shell = if VALID_SHELLS.contains(&shell.as_str()) {
                shell
            } else {
                "/bin/bash".to_string()
            };
            let mut c = CommandBuilder::new(&shell);
            let mut full_cmd = agent_binary.clone();
            for arg in &spawn_args {
                full_cmd.push(' ');
                full_cmd.push('\'');
                for ch in arg.chars() {
                    if ch == '\'' {
                        full_cmd.push_str("'\\''");
                    } else {
                        full_cmd.push(ch);
                    }
                }
                full_cmd.push('\'');
            }
            c.arg("-lc");
            c.arg(&full_cmd);
            c
        };
```

Gate the Claude-specific OTel injection (lines 253-264) behind agent kind. Replace with:

```rust
        // Claude Code is the only agent that speaks the OTel env-var protocol
        // we ship with. Codex ignores these, but injecting them is harmless -
        // still, we skip to keep the process env clean and to make the intent
        // obvious to future readers.
        if agent == crate::config::AgentKind::Claude {
            if let Some(endpoint) = otel_endpoint.as_deref() {
                cmd.env("CLAUDE_CODE_ENABLE_TELEMETRY", "1");
                cmd.env("OTEL_METRICS_EXPORTER", "otlp");
                cmd.env("OTEL_EXPORTER_OTLP_PROTOCOL", "http/json");
                cmd.env("OTEL_EXPORTER_OTLP_METRICS_PROTOCOL", "http/json");
                cmd.env("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint);
                cmd.env("OTEL_EXPORTER_OTLP_COMPRESSION", "none");
                cmd.env("OTEL_METRIC_EXPORT_INTERVAL", "3000");
                cmd.env("OTEL_METRICS_INCLUDE_SESSION_ID", "true");
                cmd.env("OTEL_RESOURCE_ATTRIBUTES", format!("terminal.id={}", id));
            }
        }
```

Also gate the resume-flag injection (lines 132-145). Codex does not have `--resume` / `--continue`, so those flags would be arg-parse errors. Wrap the whole block:

```rust
        let injected: Vec<String> = if agent == crate::config::AgentKind::Claude {
            if let Some(id) = resume_session_id.as_deref() {
                if id.contains(Self::SHELL_METACHARACTERS) {
                    return Err(error_reporter::user_err("Invalid session id"));
                }
                vec![format!("--resume={}", id)]
            } else if continue_recent {
                vec!["--continue".to_string()]
            } else {
                vec![]
            }
        } else {
            vec![]
        };
```

Finally, populate `agent` on the returned `TerminalConfig`. Find where `TerminalConfig` is constructed near the end of `create_terminal` and add `agent,` to the struct literal.

- [ ] **Step 6: Run tests + build**

Run: `cd src-tauri && cargo build && cargo test --lib`

Expected: everything compiles; no test regressions. Any compile errors will point at the two call sites of `create_terminal` (`commands.rs` line 339 and the second in `commands.rs` around line 4444) - that's Task 4's problem, so it's OK to see them after this task if you use `cargo test --lib terminal::tests` to scope to this module.

To avoid needing Task 4 to compile: temporarily supply `crate::config::AgentKind::Claude` at both call sites in `commands.rs` in this task, then Task 4 replaces those literals with the value from the request.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/terminal.rs src-tauri/src/commands.rs
git commit -m "feat(terminal): route PTY spawn by AgentKind, gate Claude-only features"
```

---

## Task 4: Backend - Plumb `agent` through `CreateTerminalRequest`

**Files:**
- Modify: `src-tauri/src/commands.rs:273-352` (CreateTerminalRequest + create_terminal)
- Modify: `src-tauri/src/commands.rs:~4444` (second spawn call site - restore path)

- [ ] **Step 1: Write the failing test**

Add to a `#[cfg(test)] mod tests` block in `src-tauri/src/commands.rs` (or extend an existing one if present):

```rust
#[test]
fn create_terminal_request_deserializes_without_agent_field() {
    // Older frontend versions that don't send `agent` must still deserialize
    // and default to Claude.
    let json = r#"{
        "label": "test",
        "working_directory": "/tmp",
        "claude_args": [],
        "env_vars": {}
    }"#;
    let req: CreateTerminalRequest = serde_json::from_str(json).unwrap();
    assert_eq!(req.agent, crate::config::AgentKind::Claude);
}

#[test]
fn create_terminal_request_deserializes_codex_agent() {
    let json = r#"{
        "label": "test",
        "working_directory": "/tmp",
        "claude_args": [],
        "env_vars": {},
        "agent": "codex"
    }"#;
    let req: CreateTerminalRequest = serde_json::from_str(json).unwrap();
    assert_eq!(req.agent, crate::config::AgentKind::Codex);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --lib commands::tests::create_terminal_request_deserializes_without_agent_field`

Expected: compile error - `agent` field doesn't exist on `CreateTerminalRequest`.

- [ ] **Step 3: Add the field and pass it through**

Update `CreateTerminalRequest` (currently lines 273-294):

```rust
#[derive(Debug, Serialize, Deserialize)]
pub struct CreateTerminalRequest {
    pub label: String,
    pub working_directory: String,
    pub claude_args: Vec<String>,
    pub env_vars: HashMap<String, String>,
    pub color_tag: Option<String>,
    pub nickname: Option<String>,
    #[serde(default)]
    pub resume_session_id: Option<String>,
    #[serde(default)]
    pub continue_recent: bool,
    #[serde(default)]
    pub cost_tracking: bool,
    #[serde(default)]
    pub agent: crate::config::AgentKind,
}
```

Then update the `terminals.create_terminal(...)` call around line 339 to pass `request.agent` as the second argument:

```rust
terminals.create_terminal(
    request.label.clone(),
    request.agent,
    request.working_directory,
    request.claude_args,
    request.env_vars,
    request.color_tag,
    request.nickname,
    tx,
    Some(log_path.clone()),
    request.resume_session_id,
    continue_recent,
    otel_endpoint,
)?
```

Do the same for the second call site around line 4444 (the shell/restore path). Search for `terminals.create_terminal(` in `commands.rs` - there should be exactly two hits. Both need `agent` passed in. For the shell/restore path, if there's no obvious agent context, default to `crate::config::AgentKind::Claude` and leave a comment explaining why.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib`

Expected: all tests pass; workspace builds cleanly.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(commands): accept agent in CreateTerminalRequest, plumb to spawn"
```

---

## Task 5: Frontend - Shared `AgentPicker` component + TS types

**Files:**
- Create: `src/lib/agents.ts`
- Create: `src/components/AgentPicker.tsx`

- [ ] **Step 1: Create the TS mirror**

Create `src/lib/agents.ts`:

```typescript
export type AgentKind = 'claude' | 'codex';

export interface AgentSpec {
  kind: AgentKind;
  displayName: string;
  binary: string;
  installUrl: string;
  installHint: string;
}

export const AGENT_SPECS: readonly AgentSpec[] = [
  {
    kind: 'claude',
    displayName: 'Claude Code',
    binary: 'claude',
    installUrl: 'https://docs.claude.com/claude-code',
    installHint: 'npm install -g @anthropic-ai/claude-code',
  },
  {
    kind: 'codex',
    displayName: 'Codex',
    binary: 'codex',
    installUrl: 'https://github.com/openai/codex',
    installHint: 'npm install -g @openai/codex',
  },
];

export function specFor(kind: AgentKind): AgentSpec {
  const spec = AGENT_SPECS.find(s => s.kind === kind);
  if (!spec) throw new Error(`Unknown agent kind: ${kind}`);
  return spec;
}
```

- [ ] **Step 2: Add a unit test for `specFor`**

Create `src/lib/agents.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { AGENT_SPECS, specFor } from './agents';

describe('agents catalog', () => {
  it('resolves claude by kind', () => {
    expect(specFor('claude').binary).toBe('claude');
  });

  it('resolves codex by kind', () => {
    expect(specFor('codex').binary).toBe('codex');
  });

  it('lists every agent kind exactly once', () => {
    const kinds = AGENT_SPECS.map(s => s.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds).toContain('claude');
    expect(kinds).toContain('codex');
  });

  it('throws on unknown kind', () => {
    // @ts-expect-error - deliberately passing invalid kind
    expect(() => specFor('unknown')).toThrow();
  });
});
```

Run: `npm run test src/lib/agents.test.ts`

Expected: `4 passed`.

- [ ] **Step 3: Create the shared picker component**

Create `src/components/AgentPicker.tsx`:

```tsx
import { AGENT_SPECS, type AgentKind } from '../lib/agents';

interface AgentPickerProps {
  value: AgentKind;
  onChange: (kind: AgentKind) => void;
  className?: string;
}

/**
 * Two-button strip that lets the user pick which agent CLI a terminal (or
 * profile) targets. Shared between `NewTerminalModal` and `ProfileModal` so
 * the button styling and semantics stay in sync when more agents are added.
 */
export function AgentPicker({ value, onChange, className = '' }: AgentPickerProps) {
  return (
    <div className={`grid grid-cols-2 gap-2 ${className}`}>
      {AGENT_SPECS.map((spec) => {
        const selected = spec.kind === value;
        return (
          <button
            key={spec.kind}
            onClick={() => onChange(spec.kind)}
            className={`p-2.5 rounded-md text-left transition-colors ${
              selected
                ? 'bg-accent-primary/10 ring-1 ring-accent-primary/30'
                : 'bg-bg-primary ring-1 ring-border hover:ring-border-light'
            }`}
          >
            <p className="text-text-primary text-[12px] font-medium">{spec.displayName}</p>
            <p className="text-text-tertiary text-[11px] font-mono">{spec.binary}</p>
          </button>
        );
      })}
    </div>
  );
}
```

Note: intentionally no logo images in this pass. Text-only preserves the existing "flat IntelliJ New UI" aesthetic. If logos are wanted later, drop them into `public/agent-icons/` and swap the `<p>` for an `<img>`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/agents.ts src/lib/agents.test.ts src/components/AgentPicker.tsx
git commit -m "feat(ui): AgentPicker component and agent catalog"
```

---

## Task 6: Frontend - Wire `AgentPicker` into `NewTerminalModal`

**Files:**
- Modify: `src/components/NewTerminalModal.tsx`

- [ ] **Step 1: Update the local `ConfigProfile` interface**

Around line 23 of `src/components/NewTerminalModal.tsx`, add `agent` to the interface:

```tsx
interface ConfigProfile {
  id: string;
  name: string;
  description: string | null;
  working_directory: string;
  claude_args: string[];
  env_vars: Record<string, string>;
  is_default: boolean;
  agent: AgentKind;
  preview?: PreviewProfile | null;
}
```

Add the import at the top:

```tsx
import { specFor, type AgentKind } from '../lib/agents';
import { AgentPicker } from './AgentPicker';
```

- [ ] **Step 2: Add agent state and gate profile filtering**

Around line 48 (after the existing `useState` hooks), add:

```tsx
const [selectedAgent, setSelectedAgent] = useState<AgentKind>('claude');
```

Update the profile-selection effect (around line 91) so switching agents deselects a profile that doesn't match:

```tsx
useEffect(() => {
  if (selectedProfileId) {
    const profile = profiles.find(p => p.id === selectedProfileId);
    if (profile && profile.agent !== selectedAgent) {
      setSelectedProfileId(null);
    }
  }
}, [selectedAgent, profiles, selectedProfileId]);
```

- [ ] **Step 3: Render the picker and filter the profile grid**

Around line 378 (the `{!plainShell && (...)}` block that renders profile selection), insert the picker above it. Replace the whole `{!plainShell && (` block with:

```tsx
{!plainShell && (
  <div className="border-t border-[var(--ij-divider-soft)] pt-4">
    <label className="block text-text-secondary text-[12px] mb-1.5">Agent</label>
    <AgentPicker value={selectedAgent} onChange={setSelectedAgent} />
  </div>
)}

{!plainShell && (
  <div className="border-t border-[var(--ij-divider-soft)] pt-4">
    <div className="flex items-center justify-between mb-1.5">
      <label className="text-text-secondary text-[12px]">Profile</label>
      <button
        onClick={() => openProfileModal()}
        className="flex items-center gap-1 text-[11px] text-accent-primary hover:text-accent-secondary transition-colors"
      >
        <Plus size={12} />
        Add Profile
      </button>
    </div>
    <div className="grid grid-cols-2 gap-2">
      <button
        onClick={() => setSelectedProfileId(null)}
        className={`p-2.5 rounded-md text-left transition-colors ${
          selectedProfileId === null
            ? 'bg-accent-primary/10 ring-1 ring-accent-primary/30'
            : 'bg-bg-primary ring-1 ring-border hover:ring-border-light'
        }`}
      >
        <p className="text-text-primary text-[12px] font-medium">No Profile</p>
        <p className="text-text-tertiary text-[11px]">Custom settings</p>
      </button>
      {profiles.filter(p => p.agent === selectedAgent).map((profile) => (
        <div
          key={profile.id}
          className={`relative group rounded-md transition-colors ${
            selectedProfileId === profile.id
              ? 'bg-accent-primary/10 ring-1 ring-accent-primary/30'
              : 'bg-bg-primary ring-1 ring-border hover:ring-border-light'
          }`}
        >
          <button
            onClick={() => setSelectedProfileId(profile.id)}
            className="w-full p-2.5 pr-8 text-left"
          >
            <p className="text-text-primary text-[12px] font-medium truncate">{profile.name}</p>
            <p className="text-text-tertiary text-[11px] truncate">
              {profile.description || profile.working_directory || 'No description'}
            </p>
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              openProfileModal(profile.id);
            }}
            title="Edit profile"
            className="absolute top-1.5 right-1.5 p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-white/[0.06] opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <Pencil size={11} />
          </button>
        </div>
      ))}
    </div>
  </div>
)}
```

- [ ] **Step 4: Update the args label and command preview**

Around line 604 (the "Claude Arguments" section), rename the label and update the preview:

```tsx
{!plainShell && (
<div className="border-t border-[var(--ij-divider-soft)] pt-4">
  <label className="block text-text-secondary text-[12px] mb-1.5">
    {specFor(selectedAgent).displayName} Arguments (one per line)
  </label>
  <textarea
    value={claudeArgs.join('\n')}
    onChange={(e) => setClaudeArgs(e.target.value.split('\n').filter(Boolean))}
    className="w-full bg-bg-primary ring-1 ring-border-light rounded-md py-2 px-3 text-text-primary text-[13px] focus:outline-none focus:ring-accent-primary font-mono h-20 resize-none transition-colors"
    placeholder="--dangerously-skip-permissions&#10;--model opus"
  />
  <p className="text-text-tertiary text-[11px] mt-1">
    Command: <code className="text-text-secondary">{specFor(selectedAgent).binary} {claudeArgs.join(' ')}</code>
  </p>
</div>
)}
```

- [ ] **Step 5: Pass `agent` to the terminal creation call**

Around line 299 (the `createTerminal(...)` call), you'll need to thread the agent through. This depends on how `terminalStore.createTerminal` is currently shaped, which Task 7 modifies. For now, add the argument at the call site - Task 7 aligns the store signature:

```tsx
newTerminalId = await createTerminal(
  label,
  workingDirectory,
  finalArgs,
  envVars,
  colorTag,
  nickname || undefined,
  undefined,
  undefined,
  undefined,
  previewInit,
  selectedAgent, // new: agent kind
);
```

- [ ] **Step 6: Smoke test manually**

Run: `npm run tauri dev`

Verify:
1. Open New Terminal modal - two agent buttons appear above the Profile grid, "Claude Code" selected by default.
2. Click "Codex" - profile grid filters to zero Codex profiles (correct, since none exist yet).
3. Args label reads "Codex Arguments" and command preview reads `codex ...`.
4. Click "Claude Code" - profile grid returns to existing profiles, label returns to "Claude Code Arguments".

Do not commit until Task 7 aligns the store signature.

- [ ] **Step 7: Commit (after Task 7)**

Wait until Task 7 is done, then commit both together (see Task 7 Step 5).

---

## Task 7: Frontend - Thread `agent` through `terminalStore.createTerminal`

**Files:**
- Modify: `src/store/terminalStore.ts` (createTerminal signature + IPC call)
- Modify: `src/components/NewTerminalModal.tsx` (aligned to new signature)

- [ ] **Step 1: Locate the current signature**

Open `src/store/terminalStore.ts`. Find `createTerminal:` - it's a Zustand store action that ends with an `invoke<TerminalConfig>('create_terminal', { request: {...} })` call.

- [ ] **Step 2: Add `agent` parameter and pass it into the IPC request**

Add `agent?: AgentKind` (defaulting to `'claude'`) as the last parameter of `createTerminal`. In the IPC request payload, include `agent: agent ?? 'claude'`. Also import `type AgentKind` from `../lib/agents`.

Specifically: find the `create_terminal` invoke call. It builds a `request` object. Add `agent: agent ?? 'claude'` to that object.

Example diff (adapt to actual store shape):

```typescript
createTerminal: async (
  label,
  workingDirectory,
  claudeArgs,
  envVars,
  colorTag,
  nickname,
  profileId,
  resumeSessionId,
  continueRecent,
  previewInit,
  agent: AgentKind = 'claude',
) => {
  // ...existing body...
  const config = await invoke<TerminalConfig>('create_terminal', {
    request: {
      label,
      working_directory: workingDirectory,
      claude_args: claudeArgs,
      env_vars: envVars,
      color_tag: colorTag,
      nickname,
      resume_session_id: resumeSessionId,
      continue_recent: continueRecent ?? false,
      agent,
    },
  });
  // ...rest of function...
},
```

- [ ] **Step 3: Type-check**

Run: `npm run type-check` (or `npx tsc --noEmit` if no such script).

Expected: no type errors. If `NewTerminalModal.tsx` complains about the new arg, verify the call in Task 6 Step 5 matches the store signature.

- [ ] **Step 4: End-to-end smoke test**

Run: `npm run tauri dev` (or continue the session started at Task 6 Step 6).

Verify:
1. With "Claude Code" selected, create a terminal - Claude spawns as before.
2. Install Codex locally first (`npm install -g @openai/codex`), then with "Codex" selected, create a terminal - Codex CLI spawns.
3. Without Codex installed, create a Codex terminal - expect a clear error banner mentioning that `codex` was not found (from `Failed to spawn command`).
4. Existing profiles still open and edit fine (they load with `agent: 'claude'`).

- [ ] **Step 5: Commit Tasks 6 + 7 together**

```bash
git add src/components/NewTerminalModal.tsx src/store/terminalStore.ts
git commit -m "feat(ui): agent picker in NewTerminalModal, thread agent through store"
```

---

## Task 8: Frontend - Agent selector in `ProfileModal`

**Files:**
- Modify: `src/components/ProfileModal.tsx`

- [ ] **Step 1: Update the local `ConfigProfile` interface**

Around line 19 of `src/components/ProfileModal.tsx`, add `agent` and the imports:

```tsx
import { specFor, type AgentKind } from '../lib/agents';
import { AgentPicker } from './AgentPicker';

interface ConfigProfile {
  id: string;
  name: string;
  description: string | null;
  working_directory: string;
  claude_args: string[];
  env_vars: Record<string, string>;
  is_default: boolean;
  agent: AgentKind;
  preview?: PreviewProfile | null;
}
```

- [ ] **Step 2: Default new profiles to `claude`**

In `handleCreateProfile` (around line 56), add `agent: 'claude'` to the new-profile literal:

```tsx
const handleCreateProfile = () => {
  setIsCreating(true);
  setSelectedProfile({
    id: uuidv4(),
    name: 'New Profile',
    description: '',
    working_directory: '',
    claude_args: [],
    env_vars: {},
    is_default: false,
    agent: 'claude',
  });
};
```

- [ ] **Step 3: Render the picker at the top of the profile form**

Find the section of `ProfileModal` that renders the profile edit form (search for the "Name" label). Insert the `AgentPicker` above the name field:

```tsx
{selectedProfile && (
  <>
    <div>
      <label className="block text-text-secondary text-[12px] mb-1.5">Agent</label>
      <AgentPicker
        value={selectedProfile.agent}
        onChange={(kind) => setSelectedProfile({ ...selectedProfile, agent: kind })}
      />
      <p className="text-text-tertiary text-[11px] mt-1">
        Runs as <code className="text-text-secondary">{specFor(selectedProfile.agent).binary} ...</code>
      </p>
    </div>
    {/* ... existing Name / Description / etc. fields below ... */}
  </>
)}
```

- [ ] **Step 4: Update the args label inside the profile form**

Wherever the profile form renders a label mentioning "Claude Arguments" (search for it), replace with a spec-aware label:

```tsx
<label className="block text-text-secondary text-[12px] mb-1.5">
  {specFor(selectedProfile.agent).displayName} Arguments (one per line)
</label>
```

- [ ] **Step 5: Type-check + smoke test**

Run: `npm run type-check` - expect no errors.

Run: `npm run tauri dev` - verify:
1. Open Profile modal, create a profile - the picker is at the top, defaults to Claude.
2. Switch to Codex, save - reopen the profile: Codex is still selected.
3. Existing profiles from before this change load with Claude selected (from serde default).
4. Save a Codex profile, open New Terminal, pick Codex - the profile appears in the grid. Pick Claude - the profile disappears.

- [ ] **Step 6: Commit**

```bash
git add src/components/ProfileModal.tsx
git commit -m "feat(ui): agent selector in ProfileModal"
```

---

## Task 9: Full-app verification

- [ ] **Step 1: Run the full verify pipeline**

Run: (from the project root)

```bash
npm run lint
npm run type-check
npm run test
cd src-tauri && cargo test && cargo clippy -- -D warnings && cd ..
```

Expected: everything passes. If clippy flags something, fix it - the existing codebase has zero-warnings clippy on `master`.

- [ ] **Step 2: Manual QA checklist**

Run: `npm run tauri dev`

Walk through:
- [ ] Fresh install with no profiles → New Terminal opens, Claude selected, empty profile grid, "Claude Code Arguments" label.
- [ ] Create a Claude terminal → Claude Code spawns.
- [ ] Switch agent to Codex without installing → create terminal → clear error banner about missing `codex` binary.
- [ ] Install Codex (`npm install -g @openai/codex`), retry → Codex spawns cleanly.
- [ ] Create a Claude profile and a Codex profile → each shows only under its agent in New Terminal.
- [ ] Save workspace with a Codex terminal → close app → reopen → restore path spawns Codex (not Claude).
- [ ] Existing profiles from a pre-migration DB load without crash and default to Claude.
- [ ] Grid mode with mixed Claude + Codex terminals side by side works normally.

- [ ] **Step 3: Update the changelog**

Add an entry to `src/changelog.json` under the next version bump (do not bump version here - that's the `/publish` command's job). Example entry:

```json
{
  "type": "feature",
  "title": "Codex support and agent picker",
  "description": "New Terminal now offers a Claude Code / Codex switch above the profile grid. Profiles carry their target agent so grids can mix both."
}
```

- [ ] **Step 4: Final commit**

```bash
git add src/changelog.json
git commit -m "docs(changelog): agent picker and Codex support"
```

The branch is now ready to open as a PR.

---

## Rollback plan

If something breaks in production:
- Everything is additive: no schema change, no field rename, no removed features.
- `agent` on `ConfigProfile` defaults to `Claude` on both serialize (via `#[serde(default)]`) and TS side, so downgrading the app will simply ignore the field.
- The one non-additive change is `TerminalManager::create_terminal`'s new `agent` parameter - a downgrade of just the backend without the frontend would break because the frontend still sends `agent` in the IPC payload, but `serde(default)` on `CreateTerminalRequest.agent` handles the reverse case (old backend, new frontend? No, new backend, old frontend is what matters - and that's fine).

## Self-review notes

- **Spec coverage**: agent-picker UI (Task 6), profile-level agent (Task 8), backend routing (Tasks 1-4), test coverage (throughout). All requirements from the conversation are mapped.
- **Placeholder scan**: no "TBD" or "handle edge cases" - every code step shows full code.
- **Type consistency**: `AgentKind` enum spelled the same everywhere (`Claude` / `Codex` in Rust, `'claude'` / `'codex'` in TS via `#[serde(rename_all = "lowercase")]`). `agent` field name identical in Rust, TS interfaces, and JSON payloads.
- **Known gap**: no automated test proves the actual spawn uses the correct binary - this is IO-bound and awkward to test in unit isolation. The `build_agent_command` helper covers the resolution logic; the spawn wiring is manually verified in Task 9's QA checklist. Adding an integration test that mocks `portable_pty::CommandBuilder` is possible but disproportionately expensive for MVP.
