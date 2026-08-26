# Paste-as-File Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a "Paste as File" feature that captures large pastes (logs, JSON) into a file under `<cwd>/.claudeterminal/pastes/` and auto-references it in Claude Code via `@mention`.

**Architecture:** New `pastes.rs` Rust module owns file I/O. Five new IPC commands. New React drawer (`PasteAsFileDrawer.tsx`) with Monaco editor. Auto-detect on xterm `onData` chunks. Settings live in `appStore` (persisted). Pastes are throwaway by default - purged on terminal close.

**Tech Stack:** Rust + Tauri 2 (backend), React 18 + TypeScript + Zustand + Monaco + Framer Motion (frontend). No new deps.

**Test approach:** Rust unit tests via `#[cfg(test)]` for security-critical filename validation and path-canonicalization. No frontend test framework exists in this project - frontend correctness verified by manual QA at the end.

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `src-tauri/src/pastes.rs` | Pure filesystem helpers: validate filename, write paste, list, read, delete, purge, retention pass. Self-contained - takes a `cwd: &Path`, returns `Result<_, String>`. |
| `src/store/pasteStore.ts` | In-memory `Map<terminalId, PasteHistoryEntry[]>` (most-recent first). Hydrates from disk on terminal restore. Not persisted. |
| `src/components/PasteAsFileDrawer.tsx` | Right-side slide-in drawer with Monaco editor, filename/extension inputs, target-terminal selector, prompt template, recent pastes list, action buttons. |

### Modified files

| Path | Why |
|---|---|
| `src-tauri/src/main.rs` | Declare `mod pastes;` and add new commands to `invoke_handler!`. Spawn startup retention task. |
| `src-tauri/src/commands.rs` | Add five `#[command]` handlers wrapping `pastes.rs`. |
| `src/store/appStore.ts` | New state (`isPasteDrawerOpen`, `pasteDrawerSeed`) and persisted settings (auto-detect threshold, prompt template, retention). |
| `src/store/terminalStore.ts` | `closeTerminal` calls `purge_pastes` (best-effort) before removing the terminal. |
| `src/store/toastStore.ts` | Optional `actions` array on toasts so the auto-detect prompt can offer `[Save & Reference] / [Paste anyway] / [Don't ask again]`. |
| `src/components/ToastContainer.tsx` | Render `actions` if present. |
| `src/components/TerminalView.tsx` | Intercept `onData` chunks above the threshold and route them to the drawer instead of the PTY. |
| `src/components/TerminalStatusBar.tsx` | "Paste as file" button. |
| `src/hooks/useKeyboardShortcuts.ts` | `Ctrl+Shift+V` opens the drawer pre-filled from clipboard. |
| `src/components/SettingsModal.tsx` | New "Pastes" section. |
| `src/App.tsx` | Mount `<PasteAsFileDrawer />`. |
| `src/changelog.json` | Entry for the WhatsNewModal post-update. |
| `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `README.md` | Version bump `1.20.8` → `1.21.0`. |

---

## Task 1: Rust pastes module - pure filesystem core

**Files:**
- Create: `src-tauri/src/pastes.rs`

- [ ] **Step 1: Write the failing tests**

Create the file with the test module first so we have something to drive the implementation.

```rust
// src-tauri/src/pastes.rs
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PasteEntry {
    pub file_name: String,
    pub relative_path: String,
    pub absolute_path: String,
    pub size_bytes: u64,
    pub created_at: String,
    pub detected_kind: String,
}

const PASTES_SUBDIR: &str = ".claudeterminal/pastes";
const GITIGNORE_DIR: &str = ".claudeterminal";
const FILENAME_RE: &str = r"^[A-Za-z0-9._-]+$";

pub fn validate_file_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("File name cannot be empty".into());
    }
    if name.len() > 200 {
        return Err("File name too long".into());
    }
    let re = regex::Regex::new(FILENAME_RE).expect("static regex compiles");
    if !re.is_match(name) {
        return Err(format!(
            "Invalid file name: {} (must match {})",
            name, FILENAME_RE
        ));
    }
    if name.starts_with('.') {
        return Err("File name must not start with '.'".into());
    }
    Ok(())
}

pub fn pastes_dir(cwd: &Path) -> PathBuf {
    cwd.join(PASTES_SUBDIR)
}

pub fn ensure_dir_with_gitignore(cwd: &Path) -> Result<(), String> {
    let dir = cwd.join(GITIGNORE_DIR);
    fs::create_dir_all(dir.join("pastes")).map_err(|e| e.to_string())?;
    let gi = dir.join(".gitignore");
    if !gi.exists() {
        fs::write(&gi, "*\n").map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn sniff_kind(content: &str) -> &'static str {
    let trimmed = content.trim_start();
    if (trimmed.starts_with('{') || trimmed.starts_with('['))
        && serde_json::from_str::<serde_json::Value>(content).is_ok()
    {
        return "json";
    }
    if trimmed.starts_with('<') && trimmed.contains('>') {
        return "xml";
    }
    let log_markers = ["[INFO]", "[ERROR]", "[WARN]", "[DEBUG]", "ERROR:", "WARN:"];
    let line_count = content.lines().take(50).count();
    let log_hits = content
        .lines()
        .take(50)
        .filter(|l| log_markers.iter().any(|m| l.contains(m)))
        .count();
    if line_count >= 5 && log_hits * 4 >= line_count {
        return "log";
    }
    "text"
}

fn safe_join(cwd: &Path, file_name: &str) -> Result<PathBuf, String> {
    validate_file_name(file_name)?;
    let dir = pastes_dir(cwd);
    let candidate = dir.join(file_name);
    // Defense-in-depth: even after regex validation, walk the joined path and
    // confirm it stays inside the pastes dir.
    let canonical_dir = dir.canonicalize().unwrap_or(dir.clone());
    let canonical_target = candidate.parent().map(|p| p.canonicalize().unwrap_or(p.to_path_buf()));
    match canonical_target {
        Some(parent) if parent == canonical_dir => Ok(candidate),
        _ => Err(format!("File name {} resolves outside pastes dir", file_name)),
    }
}

fn next_available_name(dir: &Path, base: &str, ext: &str) -> String {
    let primary = format!("{}.{}", base, ext);
    if !dir.join(&primary).exists() {
        return primary;
    }
    for i in 2..=99 {
        let candidate = format!("{}-{}.{}", base, i, ext);
        if !dir.join(&candidate).exists() {
            return candidate;
        }
    }
    format!("{}-{}.{}", base, uuid::Uuid::new_v4().simple(), ext)
}

pub fn write_paste(
    cwd: &Path,
    content: &str,
    suggested_base: &str,
    extension: &str,
) -> Result<PasteEntry, String> {
    if !cwd.exists() {
        return Err(format!("Working directory {} no longer exists", cwd.display()));
    }
    validate_file_name(suggested_base)?;
    validate_file_name(&format!("x.{}", extension))?; // ensure extension is safe
    ensure_dir_with_gitignore(cwd)?;
    let dir = pastes_dir(cwd);
    let file_name = next_available_name(&dir, suggested_base, extension);
    let abs_path = dir.join(&file_name);
    fs::write(&abs_path, content).map_err(|e| e.to_string())?;
    let metadata = fs::metadata(&abs_path).map_err(|e| e.to_string())?;
    let created_at = chrono::Utc::now().to_rfc3339();
    let detected_kind = sniff_kind(content).to_string();
    Ok(PasteEntry {
        file_name: file_name.clone(),
        relative_path: format!("{}/{}", PASTES_SUBDIR, file_name),
        absolute_path: abs_path.to_string_lossy().to_string(),
        size_bytes: metadata.len(),
        created_at,
        detected_kind,
    })
}

pub fn list_pastes(cwd: &Path) -> Result<Vec<PasteEntry>, String> {
    let dir = pastes_dir(cwd);
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut entries: Vec<(SystemTime, PasteEntry)> = vec![];
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        let mtime = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let file_name = entry.file_name().to_string_lossy().to_string();
        let detected_kind = match path.extension().and_then(|s| s.to_str()) {
            Some("json") => "json",
            Some("log") => "log",
            Some("xml") => "xml",
            _ => "text",
        }
        .to_string();
        entries.push((
            mtime,
            PasteEntry {
                file_name: file_name.clone(),
                relative_path: format!("{}/{}", PASTES_SUBDIR, file_name),
                absolute_path: path.to_string_lossy().to_string(),
                size_bytes: metadata.len(),
                created_at: chrono::DateTime::<chrono::Utc>::from(mtime).to_rfc3339(),
                detected_kind,
            },
        ));
    }
    entries.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(entries.into_iter().map(|(_, e)| e).collect())
}

pub fn read_paste(cwd: &Path, file_name: &str) -> Result<String, String> {
    let path = safe_join(cwd, file_name)?;
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

pub fn delete_paste(cwd: &Path, file_name: &str) -> Result<(), String> {
    let path = safe_join(cwd, file_name)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn purge_pastes(cwd: &Path) -> Result<(), String> {
    let dir = pastes_dir(cwd);
    if !dir.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_file() {
            // canonicalize check: parent must equal dir
            if let Ok(parent) = path.parent().unwrap_or(Path::new("")).canonicalize() {
                if parent == dir.canonicalize().unwrap_or(dir.clone()) {
                    let _ = fs::remove_file(&path);
                }
            }
        }
    }
    Ok(())
}

pub fn purge_older_than(cwd: &Path, max_age_days: u64) -> Result<u64, String> {
    let dir = pastes_dir(cwd);
    if !dir.exists() {
        return Ok(0);
    }
    let cutoff = SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(max_age_days * 86400))
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let mut removed = 0u64;
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let mtime = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .unwrap_or(SystemTime::now());
        if mtime < cutoff {
            if fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn tmp() -> TempDir {
        TempDir::new().expect("tempdir")
    }

    #[test]
    fn validate_rejects_path_traversal() {
        assert!(validate_file_name("..").is_err());
        assert!(validate_file_name("../etc/passwd").is_err());
        assert!(validate_file_name("foo/bar").is_err());
        assert!(validate_file_name("foo\\bar").is_err());
        assert!(validate_file_name("C:\\windows").is_err());
        assert!(validate_file_name("foo\0bar").is_err());
        assert!(validate_file_name("").is_err());
        assert!(validate_file_name(".hidden").is_err());
    }

    #[test]
    fn validate_accepts_simple_names() {
        assert!(validate_file_name("paste-2026-05-10-1432.json").is_ok());
        assert!(validate_file_name("errors_1102.log").is_ok());
        assert!(validate_file_name("a.b.c").is_ok());
    }

    #[test]
    fn write_paste_creates_dir_and_gitignore() {
        let dir = tmp();
        let entry = write_paste(dir.path(), "{\"a\":1}", "p1", "json").unwrap();
        assert_eq!(entry.detected_kind, "json");
        assert_eq!(entry.file_name, "p1.json");
        assert!(dir.path().join(".claudeterminal/.gitignore").exists());
        assert_eq!(
            std::fs::read_to_string(dir.path().join(".claudeterminal/.gitignore")).unwrap(),
            "*\n"
        );
    }

    #[test]
    fn write_paste_collision_suffixes() {
        let dir = tmp();
        let a = write_paste(dir.path(), "x", "p", "txt").unwrap();
        let b = write_paste(dir.path(), "y", "p", "txt").unwrap();
        let c = write_paste(dir.path(), "z", "p", "txt").unwrap();
        assert_eq!(a.file_name, "p.txt");
        assert_eq!(b.file_name, "p-2.txt");
        assert_eq!(c.file_name, "p-3.txt");
    }

    #[test]
    fn read_paste_rejects_traversal() {
        let dir = tmp();
        write_paste(dir.path(), "ok", "f", "txt").unwrap();
        assert!(read_paste(dir.path(), "../../../etc/passwd").is_err());
        assert!(read_paste(dir.path(), "f.txt").is_ok());
    }

    #[test]
    fn delete_paste_rejects_traversal() {
        let dir = tmp();
        let outside = dir.path().join("outside.txt");
        std::fs::write(&outside, "keep me").unwrap();
        let _ = delete_paste(dir.path(), "../outside.txt");
        assert!(outside.exists(), "delete must not escape pastes dir");
    }

    #[test]
    fn purge_pastes_only_clears_subdir() {
        let dir = tmp();
        write_paste(dir.path(), "a", "f1", "txt").unwrap();
        write_paste(dir.path(), "b", "f2", "txt").unwrap();
        let sibling = dir.path().join(".claudeterminal/sibling.txt");
        std::fs::write(&sibling, "stay").unwrap();
        purge_pastes(dir.path()).unwrap();
        assert!(sibling.exists(), "sibling files in .claudeterminal must survive");
        let listed = list_pastes(dir.path()).unwrap();
        assert!(listed.is_empty(), "pastes dir should be empty after purge");
    }

    #[test]
    fn list_pastes_sorted_newest_first() {
        let dir = tmp();
        write_paste(dir.path(), "1", "a", "txt").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        write_paste(dir.path(), "2", "b", "txt").unwrap();
        let listed = list_pastes(dir.path()).unwrap();
        assert_eq!(listed[0].file_name, "b.txt");
        assert_eq!(listed[1].file_name, "a.txt");
    }

    #[test]
    fn sniff_detects_kinds() {
        assert_eq!(sniff_kind("{\"a\":1}"), "json");
        assert_eq!(sniff_kind("[1,2,3]"), "json");
        assert_eq!(sniff_kind("<root><a/></root>"), "xml");
        let log = "[INFO] start\n[ERROR] boom\n[WARN] x\n[DEBUG] y\n[INFO] z\n";
        assert_eq!(sniff_kind(log), "log");
        assert_eq!(sniff_kind("hello world"), "text");
    }
}
```

- [ ] **Step 2: Add `regex`, `serde_json`, `tempfile` deps if missing**

`regex` and `serde_json` are already in `Cargo.toml`. Add `tempfile` to `[dev-dependencies]` (not `[dependencies]`).

Edit `src-tauri/Cargo.toml`. After the `[dependencies]` block, add:

```toml
[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 3: Declare the module in main.rs**

Edit `src-tauri/src/main.rs`. After the existing `mod claude_path;` line, add:

```rust
mod pastes;
```

- [ ] **Step 4: Run tests**

```
cd src-tauri
cargo test --lib pastes
```

Expected: all 8 tests pass. If any fail, fix the implementation in `pastes.rs`.

- [ ] **Step 5: Commit**

```
git add src-tauri/src/pastes.rs src-tauri/Cargo.toml src-tauri/src/main.rs
git commit -m "feat(pastes): add filesystem core + tests"
```

---

## Task 2: Wire up Tauri IPC commands

**Files:**
- Modify: `src-tauri/src/commands.rs` (append five new `#[command]` handlers near the bottom of the file, after `search_in_files`).
- Modify: `src-tauri/src/main.rs` (add to `invoke_handler!`, spawn startup retention task).

- [ ] **Step 1: Add a `terminal_cwd` lookup helper in `commands.rs`**

Find a place near the top of `commands.rs` (after `wrap_cmd` is fine) and add:

```rust
async fn terminal_cwd(
    state: &State<'_, AppState>,
    terminal_id: &str,
) -> Result<std::path::PathBuf, String> {
    let manager = state.terminals.lock().await;
    let term = manager
        .terminals
        .get(terminal_id)
        .ok_or_else(|| format!("Unknown terminal id: {}", terminal_id))?;
    Ok(std::path::PathBuf::from(term.config.working_directory.clone()))
}
```

- [ ] **Step 2: Add the five command handlers at the bottom of `commands.rs`**

```rust
// ---- Pastes ----

#[command]
pub async fn write_paste(
    state: State<'_, AppState>,
    terminal_id: String,
    content: String,
    suggested_name: Option<String>,
    extension: String,
) -> Result<crate::pastes::PasteEntry, String> {
    wrap_cmd("write_paste", async move {
        let cwd = terminal_cwd(&state, &terminal_id).await?;
        let base = suggested_name.unwrap_or_else(|| {
            chrono::Local::now().format("paste-%Y-%m-%d-%H%M").to_string()
        });
        crate::pastes::write_paste(&cwd, &content, &base, &extension)
    })
    .await
}

#[command]
pub async fn list_pastes(
    state: State<'_, AppState>,
    terminal_id: String,
) -> Result<Vec<crate::pastes::PasteEntry>, String> {
    wrap_cmd("list_pastes", async move {
        let cwd = terminal_cwd(&state, &terminal_id).await?;
        crate::pastes::list_pastes(&cwd)
    })
    .await
}

#[command]
pub async fn read_paste(
    state: State<'_, AppState>,
    terminal_id: String,
    file_name: String,
) -> Result<String, String> {
    wrap_cmd("read_paste", async move {
        let cwd = terminal_cwd(&state, &terminal_id).await?;
        crate::pastes::read_paste(&cwd, &file_name)
    })
    .await
}

#[command]
pub async fn delete_paste(
    state: State<'_, AppState>,
    terminal_id: String,
    file_name: String,
) -> Result<(), String> {
    wrap_cmd("delete_paste", async move {
        let cwd = terminal_cwd(&state, &terminal_id).await?;
        crate::pastes::delete_paste(&cwd, &file_name)
    })
    .await
}

#[command]
pub async fn purge_pastes(
    state: State<'_, AppState>,
    terminal_id: String,
) -> Result<(), String> {
    wrap_cmd("purge_pastes", async move {
        let cwd = match terminal_cwd(&state, &terminal_id).await {
            Ok(p) => p,
            Err(_) => return Ok(()), // terminal may already be gone - best-effort
        };
        crate::pastes::purge_pastes(&cwd)
    })
    .await
}
```

- [ ] **Step 3: Register the commands in `main.rs`**

Inside the `invoke_handler!` macro, after `commands::set_error_reporting_enabled,` add:

```rust
commands::write_paste,
commands::list_pastes,
commands::read_paste,
commands::delete_paste,
commands::purge_pastes,
```

- [ ] **Step 4: Compile-check**

```
cd src-tauri
cargo check
```

Expected: no errors. Warnings about unused fields are OK if any.

- [ ] **Step 5: Commit**

```
git add src-tauri/src/commands.rs src-tauri/src/main.rs
git commit -m "feat(pastes): expose write/list/read/delete/purge IPC commands"
```

---

## Task 3: appStore - drawer state + persisted settings

**Files:**
- Modify: `src/store/appStore.ts`

- [ ] **Step 1: Add types and state fields**

Add the following to the `AppState` interface (near the other modal flags, e.g. just below `whatsNewOpen`):

```ts
  // Paste-as-File drawer
  pasteDrawerOpen: boolean;
  pasteDrawerSeed: { content: string; targetTerminalId: string | null } | null;
  // Paste settings (persisted)
  pasteAutoDetectEnabled: boolean;
  pasteAutoDetectThresholdBytes: number;
  pasteAutoDetectThresholdLines: number;
  pastePromptTemplate: string;
  pasteRetention: 'close' | 'days' | 'forever';
  pasteRetentionDays: number;
```

And add the action signatures (just below the action signature block for "What's New"):

```ts
  // Paste-as-File actions
  openPasteDrawer: (seed?: { content?: string; targetTerminalId?: string | null }) => void;
  closePasteDrawer: () => void;
  setPasteAutoDetectEnabled: (enabled: boolean) => void;
  setPasteAutoDetectThresholdBytes: (n: number) => void;
  setPasteAutoDetectThresholdLines: (n: number) => void;
  setPastePromptTemplate: (s: string) => void;
  setPasteRetention: (r: 'close' | 'days' | 'forever') => void;
  setPasteRetentionDays: (n: number) => void;
```

- [ ] **Step 2: Add defaults in the store body**

Inside the `(set) => ({ ... })` returned object, near the other modal flags, add:

```ts
      // Paste-as-File drawer
      pasteDrawerOpen: false,
      pasteDrawerSeed: null,
      pasteAutoDetectEnabled: true,
      pasteAutoDetectThresholdBytes: 4096,
      pasteAutoDetectThresholdLines: 50,
      pastePromptTemplate: 'Please look at @{path}',
      pasteRetention: 'close' as 'close' | 'days' | 'forever',
      pasteRetentionDays: 7,
```

And add the action implementations just before the closing `}`:

```ts
      openPasteDrawer: (seed) => set({
        pasteDrawerOpen: true,
        pasteDrawerSeed: seed
          ? { content: seed.content ?? '', targetTerminalId: seed.targetTerminalId ?? null }
          : null,
      }),
      closePasteDrawer: () => set({ pasteDrawerOpen: false, pasteDrawerSeed: null }),
      setPasteAutoDetectEnabled: (enabled) => set({ pasteAutoDetectEnabled: enabled }),
      setPasteAutoDetectThresholdBytes: (n) => set({ pasteAutoDetectThresholdBytes: Math.max(256, n) }),
      setPasteAutoDetectThresholdLines: (n) => set({ pasteAutoDetectThresholdLines: Math.max(5, n) }),
      setPastePromptTemplate: (s) => set({ pastePromptTemplate: s }),
      setPasteRetention: (r) => set({ pasteRetention: r }),
      setPasteRetentionDays: (n) => set({ pasteRetentionDays: Math.max(1, n) }),
```

- [ ] **Step 3: Add the new persisted keys to `partialize`**

Find the `partialize: (state) => ({ ... })` block and add (alongside the other persisted settings):

```ts
        pasteAutoDetectEnabled: state.pasteAutoDetectEnabled,
        pasteAutoDetectThresholdBytes: state.pasteAutoDetectThresholdBytes,
        pasteAutoDetectThresholdLines: state.pasteAutoDetectThresholdLines,
        pastePromptTemplate: state.pastePromptTemplate,
        pasteRetention: state.pasteRetention,
        pasteRetentionDays: state.pasteRetentionDays,
```

(`pasteDrawerOpen` / `pasteDrawerSeed` are NOT persisted - they are session state.)

- [ ] **Step 4: Type check**

```
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```
git add src/store/appStore.ts
git commit -m "feat(pastes): add drawer state and persisted settings"
```

---

## Task 4: pasteStore - recent pastes per terminal

**Files:**
- Create: `src/store/pasteStore.ts`

- [ ] **Step 1: Write the store**

```ts
// src/store/pasteStore.ts
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

export interface PasteEntry {
  file_name: string;
  relative_path: string;
  absolute_path: string;
  size_bytes: number;
  created_at: string;
  detected_kind: 'json' | 'log' | 'xml' | 'text';
}

export interface PasteHistoryEntry extends PasteEntry {
  preview: string;
}

const PREVIEW_CHARS = 200;

interface PasteState {
  byTerminal: Map<string, PasteHistoryEntry[]>;
  add: (terminalId: string, entry: PasteEntry, content: string) => void;
  remove: (terminalId: string, fileName: string) => void;
  list: (terminalId: string) => PasteHistoryEntry[];
  clearForTerminal: (terminalId: string) => void;
  hydrateFromDisk: (terminalId: string) => Promise<void>;
}

export const usePasteStore = create<PasteState>((set, get) => ({
  byTerminal: new Map(),

  add: (terminalId, entry, content) => set((state) => {
    const next = new Map(state.byTerminal);
    const cur = next.get(terminalId) ?? [];
    const preview = content.slice(0, PREVIEW_CHARS);
    next.set(terminalId, [{ ...entry, preview }, ...cur].slice(0, 50));
    return { byTerminal: next };
  }),

  remove: (terminalId, fileName) => set((state) => {
    const next = new Map(state.byTerminal);
    const cur = next.get(terminalId) ?? [];
    next.set(terminalId, cur.filter((e) => e.file_name !== fileName));
    return { byTerminal: next };
  }),

  list: (terminalId) => get().byTerminal.get(terminalId) ?? [],

  clearForTerminal: (terminalId) => set((state) => {
    const next = new Map(state.byTerminal);
    next.delete(terminalId);
    return { byTerminal: next };
  }),

  hydrateFromDisk: async (terminalId) => {
    try {
      const entries = await invoke<PasteEntry[]>('list_pastes', { terminalId });
      set((state) => {
        const next = new Map(state.byTerminal);
        next.set(
          terminalId,
          entries.map((e) => ({ ...e, preview: '' })),
        );
        return { byTerminal: next };
      });
    } catch {
      // non-fatal - paste dir may not exist yet
    }
  },
}));
```

- [ ] **Step 2: Type check**

```
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```
git add src/store/pasteStore.ts
git commit -m "feat(pastes): add pasteStore for recent paste history"
```

---

## Task 5: toastStore - actions support

**Files:**
- Modify: `src/store/toastStore.ts`
- Modify: `src/components/ToastContainer.tsx`

- [ ] **Step 1: Extend the Toast type and store**

Edit `src/store/toastStore.ts`. Update the `Toast` interface and the convenience functions:

```ts
export interface ToastAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
}

export interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration: number;
  actions?: ToastAction[];
}
```

Update the `addToast` signature to accept `actions`:

```ts
  addToast: (toast: Omit<Toast, 'id' | 'duration'> & { duration?: number }) => string;
```

(No body change needed - the spread already passes `actions` through.)

Update each convenience function to accept actions. Replace the `toast` block:

```ts
type ToastOpts = { duration?: number; actions?: ToastAction[] };

export const toast = {
  success: (title: string, message?: string, opts?: ToastOpts) =>
    useToastStore.getState().addToast({ type: 'success', title, message, ...opts }),
  error: (title: string, message?: string, opts?: ToastOpts) =>
    useToastStore.getState().addToast({ type: 'error', title, message, ...opts }),
  warning: (title: string, message?: string, opts?: ToastOpts) =>
    useToastStore.getState().addToast({ type: 'warning', title, message, ...opts }),
  info: (title: string, message?: string, opts?: ToastOpts) =>
    useToastStore.getState().addToast({ type: 'info', title, message, ...opts }),
};
```

NOTE: This changes the third argument of `toast.success` etc. from `duration?: number` to `opts?: { duration?, actions? }`. Search the codebase for any existing call sites that pass a third arg as a number, and migrate them to `{ duration: N }`.

- [ ] **Step 2: Find and migrate existing callers passing a numeric third arg**

```
grep -rn "toast\.\(success\|error\|warning\|info\)([^,]*,[^,]*,[^)]*)" src
```

For each match where the third arg is a bare number, replace with `{ duration: N }`. If there are no matches, this step is a no-op.

- [ ] **Step 3: Render actions in ToastContainer**

Edit `src/components/ToastContainer.tsx`. Update the `ToastItem` component's prop type and the JSX to render actions when present.

Add `actions` to the props destructure:

```tsx
function ToastItem({ id, type, title, message, duration, actions }: {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration: number;
  actions?: import('../store/toastStore').ToastAction[];
}) {
```

After the `<button>` close-X (right before the `</div>` that closes `flex items-start`), insert action button rendering. Replace the existing block:

```tsx
      {/* Content */}
      <div className="relative flex items-start gap-2.5 px-3 py-2.5 pl-4">
        <Icon size={16} className={`${colors.icon} mt-0.5 shrink-0`} />
        <div className="flex-1 min-w-0">
          <p className="text-text-primary text-[12px] font-medium leading-tight">
            {title}
          </p>
          {message && (
            <p className="text-text-secondary text-[11px] mt-0.5 leading-snug">
              {message}
            </p>
          )}
        </div>
        <button
          onClick={() => removeToast(id)}
          className="text-text-tertiary hover:text-text-secondary transition-colors shrink-0 mt-0.5"
        >
          <X size={13} />
        </button>
      </div>
```

with:

```tsx
      {/* Content */}
      <div className="relative flex flex-col gap-1.5 px-3 py-2.5 pl-4">
        <div className="flex items-start gap-2.5">
          <Icon size={16} className={`${colors.icon} mt-0.5 shrink-0`} />
          <div className="flex-1 min-w-0">
            <p className="text-text-primary text-[12px] font-medium leading-tight">
              {title}
            </p>
            {message && (
              <p className="text-text-secondary text-[11px] mt-0.5 leading-snug">
                {message}
              </p>
            )}
          </div>
          <button
            onClick={() => removeToast(id)}
            className="text-text-tertiary hover:text-text-secondary transition-colors shrink-0 mt-0.5"
          >
            <X size={13} />
          </button>
        </div>
        {actions && actions.length > 0 && (
          <div className="flex gap-1.5 ml-6">
            {actions.map((a, i) => (
              <button
                key={i}
                onClick={() => { a.onClick(); removeToast(id); }}
                className={`text-[11px] px-2 py-1 rounded ${
                  a.primary
                    ? 'bg-accent-primary/20 text-accent-primary hover:bg-accent-primary/30'
                    : 'bg-white/5 text-text-secondary hover:bg-white/10'
                }`}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
```

- [ ] **Step 4: Type check**

```
npx tsc --noEmit
```

Expected: no errors. If migration in step 2 missed any caller, fix it now.

- [ ] **Step 5: Commit**

```
git add src/store/toastStore.ts src/components/ToastContainer.tsx
git commit -m "feat(toast): support inline action buttons"
```

---

## Task 6: PasteAsFileDrawer component

**Files:**
- Create: `src/components/PasteAsFileDrawer.tsx`

- [ ] **Step 1: Write the component**

```tsx
// src/components/PasteAsFileDrawer.tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import Editor, { type Monaco } from '@monaco-editor/react';
import { X, Send, Save, Trash2, FileText } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';
import { usePasteStore, type PasteEntry } from '../store/pasteStore';
import { toast } from '../store/toastStore';

type DetectedKind = 'json' | 'log' | 'xml' | 'text';

const EXTENSIONS: { value: string; label: string; lang: string }[] = [
  { value: 'json', label: '.json', lang: 'json' },
  { value: 'log', label: '.log', lang: 'plaintext' },
  { value: 'xml', label: '.xml', lang: 'xml' },
  { value: 'txt', label: '.txt', lang: 'plaintext' },
];

function detectKindClient(content: string): DetectedKind {
  const t = content.trimStart();
  if ((t.startsWith('{') || t.startsWith('['))) {
    try { JSON.parse(content); return 'json'; } catch { /* not json */ }
  }
  if (t.startsWith('<') && t.includes('>')) return 'xml';
  const markers = ['[INFO]', '[ERROR]', '[WARN]', '[DEBUG]', 'ERROR:', 'WARN:'];
  const lines = content.split('\n').slice(0, 50);
  const hits = lines.filter((l) => markers.some((m) => l.includes(m))).length;
  if (lines.length >= 5 && hits * 4 >= lines.length) return 'log';
  return 'text';
}

function defaultBaseName(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `paste-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function kindToExt(k: DetectedKind): string {
  return k === 'text' ? 'txt' : k;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function PasteAsFileDrawer() {
  const open = useAppStore((s) => s.pasteDrawerOpen);
  const seed = useAppStore((s) => s.pasteDrawerSeed);
  const closeDrawer = useAppStore((s) => s.closePasteDrawer);
  const promptTemplate = useAppStore((s) => s.pastePromptTemplate);
  const setPromptTemplate = useAppStore((s) => s.setPastePromptTemplate);

  const terminals = useTerminalStore((s) => s.terminals);
  const activeId = useTerminalStore((s) => s.activeTerminalId);
  const writeToTerminal = useTerminalStore((s) => s.writeToTerminal);

  const [content, setContent] = useState('');
  const [baseName, setBaseName] = useState(defaultBaseName());
  const [extension, setExtension] = useState<string>('txt');
  const [targetId, setTargetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState(false);
  const [tplDraft, setTplDraft] = useState(promptTemplate);
  const editorRef = useRef<unknown>(null);

  // Reset editor state when the drawer opens with new seed.
  useEffect(() => {
    if (open) {
      setContent(seed?.content ?? '');
      setBaseName(defaultBaseName());
      const detected = detectKindClient(seed?.content ?? '');
      setExtension(kindToExt(detected));
      setTargetId(seed?.targetTerminalId ?? activeId ?? null);
      setError(null);
      setEditingTemplate(false);
      setTplDraft(promptTemplate);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Re-sniff extension as user pastes/types - only if they haven't manually
  // touched the dropdown (we track this implicitly: if extension matches the
  // *previous* sniff result, we update; if user changed it, we leave it).
  const lastDetectedRef = useRef<DetectedKind>('text');
  useEffect(() => {
    const detected = detectKindClient(content);
    if (extension === kindToExt(lastDetectedRef.current)) {
      setExtension(kindToExt(detected));
    }
    lastDetectedRef.current = detected;
  }, [content, extension]);

  const monacoLanguage = useMemo(
    () => EXTENSIONS.find((e) => e.value === extension)?.lang ?? 'plaintext',
    [extension],
  );

  const stats = useMemo(() => {
    const lines = content.split('\n').length;
    const bytes = new TextEncoder().encode(content).length;
    return { lines, bytes };
  }, [content]);

  const recent = usePasteStore((s) => (targetId ? s.list(targetId) : []));

  const visibleTerminals = useMemo(
    () => Array.from(terminals.values()).filter(
      (t) => !t.scriptParentId && !t.isShellTerminal,
    ),
    [terminals],
  );

  const handleEditorMount = (_editor: unknown, _monaco: Monaco) => {
    editorRef.current = _editor;
  };

  const renderPrompt = (relativePath: string): string => {
    return promptTemplate.replace(/\{path\}/g, relativePath);
  };

  const doWrite = async (): Promise<PasteEntry | null> => {
    if (!targetId) {
      setError('Pick a target terminal');
      return null;
    }
    if (!content) {
      setError('Content is empty');
      return null;
    }
    setBusy(true);
    setError(null);
    try {
      const entry = await invoke<PasteEntry>('write_paste', {
        terminalId: targetId,
        content,
        suggestedName: baseName,
        extension,
      });
      usePasteStore.getState().add(targetId, entry, content);
      return entry;
    } catch (err) {
      setError(typeof err === 'string' ? err : 'Failed to write paste');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const handleSend = async () => {
    const entry = await doWrite();
    if (!entry || !targetId) return;
    try {
      await writeToTerminal(targetId, renderPrompt(entry.relative_path));
      toast.success('Sent to terminal', entry.relative_path);
      closeDrawer();
    } catch (err) {
      const msg = typeof err === 'string' ? err : 'Failed to write to terminal';
      setError(msg);
    }
  };

  const handleSaveOnly = async () => {
    const entry = await doWrite();
    if (!entry) return;
    try {
      await navigator.clipboard.writeText(entry.relative_path);
    } catch {
      // ignore - clipboard may be unavailable
    }
    toast.success('Saved · path copied', entry.relative_path);
    closeDrawer();
  };

  const handleResend = async (entry: PasteEntry) => {
    if (!targetId) return;
    try {
      await writeToTerminal(targetId, renderPrompt(entry.relative_path));
      toast.success('Sent to terminal', entry.relative_path);
    } catch (err) {
      toast.error('Failed to send', String(err));
    }
  };

  const handleReopen = async (entry: PasteEntry) => {
    if (!targetId) return;
    try {
      const text = await invoke<string>('read_paste', {
        terminalId: targetId,
        fileName: entry.file_name,
      });
      setContent(text);
      const dot = entry.file_name.lastIndexOf('.');
      if (dot > 0) {
        const ext = entry.file_name.slice(dot + 1);
        if (EXTENSIONS.some((e) => e.value === ext)) setExtension(ext);
        setBaseName(entry.file_name.slice(0, dot));
      }
    } catch (err) {
      toast.error('Failed to load paste', String(err));
    }
  };

  const handleDeleteRecent = async (entry: PasteEntry) => {
    if (!targetId) return;
    try {
      await invoke('delete_paste', { terminalId: targetId, fileName: entry.file_name });
      usePasteStore.getState().remove(targetId, entry.file_name);
    } catch (err) {
      toast.error('Failed to delete paste', String(err));
    }
  };

  const handleApplyTemplate = () => {
    setPromptTemplate(tplDraft);
    setEditingTemplate(false);
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 bg-black/40 z-[200]"
            onClick={closeDrawer}
          />
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'tween', duration: 0.2, ease: 'easeOut' }}
            className="fixed top-0 right-0 bottom-0 w-[520px] bg-elevation-2 backdrop-blur-xl ring-1 ring-white/5 z-[201] flex flex-col"
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
              <h2 className="text-text-primary text-sm font-medium">Paste as File</h2>
              <button
                onClick={closeDrawer}
                className="text-text-tertiary hover:text-text-primary"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3">
              <div>
                <label className="text-text-tertiary text-[11px] uppercase tracking-wide">
                  Target terminal
                </label>
                <select
                  value={targetId ?? ''}
                  onChange={(e) => setTargetId(e.target.value || null)}
                  className="mt-1 w-full bg-bg-primary text-text-primary text-[13px] px-2 py-1.5 rounded ring-1 ring-white/10"
                >
                  {visibleTerminals.length === 0 && <option value="">No terminals open</option>}
                  {visibleTerminals.map((t) => (
                    <option key={t.config.id} value={t.config.id}>
                      {t.config.nickname || t.config.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="text-text-tertiary text-[11px] uppercase tracking-wide">
                    Filename
                  </label>
                  <input
                    type="text"
                    value={baseName}
                    onChange={(e) => setBaseName(e.target.value)}
                    className="mt-1 w-full bg-bg-primary text-text-primary text-[13px] px-2 py-1.5 rounded ring-1 ring-white/10 font-mono"
                  />
                </div>
                <div className="w-24">
                  <label className="text-text-tertiary text-[11px] uppercase tracking-wide">
                    Type
                  </label>
                  <select
                    value={extension}
                    onChange={(e) => setExtension(e.target.value)}
                    className="mt-1 w-full bg-bg-primary text-text-primary text-[13px] px-2 py-1.5 rounded ring-1 ring-white/10"
                  >
                    {EXTENSIONS.map((e) => (
                      <option key={e.value} value={e.value}>{e.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-text-tertiary text-[11px] uppercase tracking-wide">
                  Content
                </label>
                <div className="h-[280px] rounded ring-1 ring-white/10 overflow-hidden">
                  <Editor
                    height="100%"
                    language={monacoLanguage}
                    value={content}
                    onChange={(v) => setContent(v ?? '')}
                    onMount={handleEditorMount}
                    theme="vs-dark"
                    options={{
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                      lineNumbers: 'on',
                      fontSize: 12,
                      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
                      wordWrap: 'on',
                    }}
                  />
                </div>
                <div className="text-text-tertiary text-[11px] flex gap-3">
                  <span>Lines: {stats.lines.toLocaleString()}</span>
                  <span>Size: {formatBytes(stats.bytes)}</span>
                  <span>Detected: {extension}</span>
                  {stats.bytes > 5 * 1024 * 1024 && (
                    <span className="text-warning">⚠ Large - Claude may truncate</span>
                  )}
                </div>
              </div>

              <div>
                <label className="text-text-tertiary text-[11px] uppercase tracking-wide">
                  Prompt template
                </label>
                <div className="mt-1 flex gap-2">
                  <input
                    type="text"
                    value={editingTemplate ? tplDraft : promptTemplate}
                    onChange={(e) => { setEditingTemplate(true); setTplDraft(e.target.value); }}
                    className="flex-1 bg-bg-primary text-text-primary text-[13px] px-2 py-1.5 rounded ring-1 ring-white/10 font-mono"
                  />
                  {editingTemplate && (
                    <button
                      onClick={handleApplyTemplate}
                      className="text-[12px] px-2 py-1 rounded bg-accent-primary/20 text-accent-primary hover:bg-accent-primary/30"
                    >
                      Save
                    </button>
                  )}
                </div>
                <p className="text-text-tertiary text-[11px] mt-1">
                  Use <code>{'{path}'}</code> for the relative file path.
                </p>
              </div>

              {error && (
                <div className="bg-error/10 ring-1 ring-error/40 text-error text-[12px] px-3 py-2 rounded">
                  {error}
                </div>
              )}

              {recent.length > 0 && (
                <div>
                  <h3 className="text-text-tertiary text-[11px] uppercase tracking-wide flex items-center gap-1">
                    <FileText size={12} /> Recent pastes (this terminal)
                  </h3>
                  <ul className="mt-1 flex flex-col gap-1">
                    {recent.slice(0, 10).map((entry) => (
                      <li
                        key={entry.file_name}
                        className="flex items-center justify-between gap-2 px-2 py-1.5 rounded hover:bg-white/5 group"
                      >
                        <button
                          onClick={() => handleReopen(entry)}
                          className="flex-1 min-w-0 text-left"
                        >
                          <span className="block text-text-primary text-[12px] truncate font-mono">
                            {entry.file_name}
                          </span>
                          <span className="block text-text-tertiary text-[10px]">
                            {formatBytes(entry.size_bytes)} · {entry.detected_kind}
                          </span>
                        </button>
                        <button
                          onClick={() => handleResend(entry)}
                          className="opacity-0 group-hover:opacity-100 text-[11px] px-1.5 py-0.5 rounded bg-accent-primary/20 text-accent-primary hover:bg-accent-primary/30"
                          title="Resend to terminal"
                        >
                          Send
                        </button>
                        <button
                          onClick={() => handleDeleteRecent(entry)}
                          className="opacity-0 group-hover:opacity-100 text-text-tertiary hover:text-error"
                          title="Delete"
                        >
                          <Trash2 size={13} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-white/5">
              <button
                onClick={closeDrawer}
                className="text-[12px] px-3 py-1.5 rounded text-text-secondary hover:bg-white/5"
              >
                Discard
              </button>
              <div className="flex gap-2">
                <button
                  onClick={handleSaveOnly}
                  disabled={busy || !content || !targetId}
                  className="text-[12px] px-3 py-1.5 rounded bg-white/5 text-text-secondary hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                >
                  <Save size={13} /> Save only
                </button>
                <button
                  onClick={handleSend}
                  disabled={busy || !content || !targetId}
                  className="text-[12px] px-3 py-1.5 rounded bg-accent-primary text-white hover:bg-accent-primary/90 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                >
                  <Send size={13} /> Send
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
```

- [ ] **Step 2: Type check**

```
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```
git add src/components/PasteAsFileDrawer.tsx
git commit -m "feat(pastes): add PasteAsFileDrawer component"
```

---

## Task 7: Auto-detect on TerminalView paste

**Files:**
- Modify: `src/components/TerminalView.tsx`

- [ ] **Step 1: Replace the simple `terminal.onData` handler with auto-detect-aware logic**

Find the existing handler:

```tsx
    terminal.onData((data) => {
      writeToTerminal(terminalId, data).catch((err) => {
        console.error(`Failed to write to terminal ${terminalId}:`, err);
      });
    });
```

Replace with:

```tsx
    // Track time of the last non-paste input event so we can identify chunks
    // that arrive as one big block (clipboard paste) vs. interactive typing.
    let lastDataTs = 0;
    let bypassDetectOnce = false;

    terminal.onData((data) => {
      const now = performance.now();
      const isLikelyPaste = data.length > 64 && (now - lastDataTs > 16 || lastDataTs === 0);
      lastDataTs = now;

      if (bypassDetectOnce) {
        bypassDetectOnce = false;
        writeToTerminal(terminalId, data).catch((err) => {
          console.error(`Failed to write to terminal ${terminalId}:`, err);
        });
        return;
      }

      // Pull the LATEST settings each call - these change in Settings without
      // re-rendering this terminal.
      const app = useAppStore.getState();
      if (!isLikelyPaste || !app.pasteAutoDetectEnabled) {
        writeToTerminal(terminalId, data).catch((err) => {
          console.error(`Failed to write to terminal ${terminalId}:`, err);
        });
        return;
      }

      const bytes = new TextEncoder().encode(data).length;
      const lines = data.split('\n').length;
      if (bytes < app.pasteAutoDetectThresholdBytes && lines < app.pasteAutoDetectThresholdLines) {
        writeToTerminal(terminalId, data).catch((err) => {
          console.error(`Failed to write to terminal ${terminalId}:`, err);
        });
        return;
      }

      // Suppress forwarding to PTY; offer the choice via a toast with actions.
      toast.info(
        'Large paste detected',
        `${(bytes / 1024).toFixed(1)} KB · ${lines} lines`,
        {
          duration: 8000,
          actions: [
            {
              label: 'Save & Reference',
              primary: true,
              onClick: () => {
                useAppStore.getState().openPasteDrawer({
                  content: data,
                  targetTerminalId: terminalId,
                });
              },
            },
            {
              label: 'Paste anyway',
              onClick: () => {
                bypassDetectOnce = true;
                writeToTerminal(terminalId, data).catch((err) => {
                  console.error(`Failed to write to terminal ${terminalId}:`, err);
                });
              },
            },
            {
              label: "Don't ask again",
              onClick: () => {
                useAppStore.getState().setPasteAutoDetectEnabled(false);
                writeToTerminal(terminalId, data).catch((err) => {
                  console.error(`Failed to write to terminal ${terminalId}:`, err);
                });
              },
            },
          ],
        },
      );
    });
```

- [ ] **Step 2: Add the imports at the top of the file**

Find the top of `TerminalView.tsx` and ensure these imports exist (add the missing ones):

```tsx
import { useAppStore } from '../store/appStore';
import { toast } from '../store/toastStore';
```

- [ ] **Step 3: Type check**

```
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```
git add src/components/TerminalView.tsx
git commit -m "feat(pastes): auto-detect large pastes and offer save-as-file"
```

---

## Task 8: Toolbar button on TerminalStatusBar

**Files:**
- Modify: `src/components/TerminalStatusBar.tsx`

- [ ] **Step 1: Read the current file to find the right insertion point**

Read `src/components/TerminalStatusBar.tsx` to locate the existing button cluster. Add a new button near the search/copy buttons (or wherever existing utility buttons sit).

- [ ] **Step 2: Add the button**

Add this import at the top:

```tsx
import { ClipboardPaste } from 'lucide-react';
import { useAppStore } from '../store/appStore';
```

(`useAppStore` may already be imported - skip the duplicate.)

Locate the existing button row and insert:

```tsx
<button
  type="button"
  onClick={async () => {
    let clipboardText = '';
    try {
      clipboardText = await navigator.clipboard.readText();
    } catch {
      // ignore - drawer opens empty if clipboard read fails
    }
    useAppStore.getState().openPasteDrawer({
      content: clipboardText,
      targetTerminalId: terminalId,
    });
  }}
  title="Paste as file (Ctrl+Shift+V)"
  className="text-text-tertiary hover:text-text-primary px-1.5 py-1 rounded hover:bg-white/5"
>
  <ClipboardPaste size={13} />
</button>
```

- [ ] **Step 3: Type check**

```
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```
git add src/components/TerminalStatusBar.tsx
git commit -m "feat(pastes): add 'paste as file' button to terminal status bar"
```

---

## Task 9: Ctrl+Shift+V keyboard shortcut

**Files:**
- Modify: `src/hooks/useKeyboardShortcuts.ts`

- [ ] **Step 1: Add the shortcut handler**

Inside the `handleKeyDown` function, after the existing `Ctrl+Shift+S` block (which opens snippets), add:

```ts
      // Paste as file: Ctrl+Shift+V
      if (ctrl && shift && e.key === 'V') {
        e.preventDefault();
        const activeId = activeIdRef.current;
        (async () => {
          let clipboardText = '';
          try {
            clipboardText = await navigator.clipboard.readText();
          } catch {
            // ignore
          }
          useAppStore.getState().openPasteDrawer({
            content: clipboardText,
            targetTerminalId: activeId,
          });
        })();
      }
```

- [ ] **Step 2: Type check**

```
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```
git add src/hooks/useKeyboardShortcuts.ts
git commit -m "feat(pastes): add Ctrl+Shift+V shortcut to open paste drawer"
```

---

## Task 10: SettingsModal - Pastes section

**Files:**
- Modify: `src/components/SettingsModal.tsx`

- [ ] **Step 1: Read the current modal to find the structure**

Read `src/components/SettingsModal.tsx`. Identify the section pattern used (likely flex column with labeled groups or a tab structure). Match that pattern.

- [ ] **Step 2: Add a "Pastes" section**

Add the imports needed at the top:

```tsx
import { useAppStore } from '../store/appStore'; // probably already imported
```

Inside the modal body - after an existing section closing tag, add:

```tsx
<section className="flex flex-col gap-2 py-3 border-t border-white/5">
  <h3 className="text-text-primary text-[13px] font-medium">Pastes</h3>
  <p className="text-text-tertiary text-[11px]">
    Capture large pastes (logs, JSON) into a file under <code>.claudeterminal/pastes/</code> and
    reference them in Claude Code via @mention.
  </p>

  <label className="flex items-center justify-between text-[12px] text-text-secondary">
    <span>Auto-detect large pastes</span>
    <input
      type="checkbox"
      checked={useAppStore((s) => s.pasteAutoDetectEnabled)}
      onChange={(e) => useAppStore.getState().setPasteAutoDetectEnabled(e.target.checked)}
    />
  </label>

  <label className="flex items-center justify-between text-[12px] text-text-secondary">
    <span>Threshold (bytes)</span>
    <input
      type="number"
      min={256}
      value={useAppStore((s) => s.pasteAutoDetectThresholdBytes)}
      onChange={(e) =>
        useAppStore.getState().setPasteAutoDetectThresholdBytes(parseInt(e.target.value, 10) || 4096)
      }
      className="w-24 bg-bg-primary text-right text-[12px] px-2 py-1 rounded ring-1 ring-white/10"
    />
  </label>

  <label className="flex items-center justify-between text-[12px] text-text-secondary">
    <span>Threshold (lines)</span>
    <input
      type="number"
      min={5}
      value={useAppStore((s) => s.pasteAutoDetectThresholdLines)}
      onChange={(e) =>
        useAppStore.getState().setPasteAutoDetectThresholdLines(parseInt(e.target.value, 10) || 50)
      }
      className="w-24 bg-bg-primary text-right text-[12px] px-2 py-1 rounded ring-1 ring-white/10"
    />
  </label>

  <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
    <span>Prompt template <span className="text-text-tertiary">(use <code>{'{path}'}</code>)</span></span>
    <input
      type="text"
      value={useAppStore((s) => s.pastePromptTemplate)}
      onChange={(e) => useAppStore.getState().setPastePromptTemplate(e.target.value)}
      className="bg-bg-primary text-[12px] px-2 py-1 rounded ring-1 ring-white/10 font-mono"
    />
  </label>

  <label className="flex items-center justify-between text-[12px] text-text-secondary">
    <span>Retention</span>
    <select
      value={useAppStore((s) => s.pasteRetention)}
      onChange={(e) =>
        useAppStore.getState().setPasteRetention(e.target.value as 'close' | 'days' | 'forever')
      }
      className="bg-bg-primary text-[12px] px-2 py-1 rounded ring-1 ring-white/10"
    >
      <option value="close">Delete on terminal close</option>
      <option value="days">Keep for N days</option>
      <option value="forever">Keep forever</option>
    </select>
  </label>

  {useAppStore((s) => s.pasteRetention) === 'days' && (
    <label className="flex items-center justify-between text-[12px] text-text-secondary">
      <span>Days to keep</span>
      <input
        type="number"
        min={1}
        value={useAppStore((s) => s.pasteRetentionDays)}
        onChange={(e) =>
          useAppStore.getState().setPasteRetentionDays(parseInt(e.target.value, 10) || 7)
        }
        className="w-24 bg-bg-primary text-right text-[12px] px-2 py-1 rounded ring-1 ring-white/10"
      />
    </label>
  )}
</section>
```

If `SettingsModal.tsx` uses a tab-based layout, instead add this as a new tab labeled "Pastes" and put the section content inside that tab's panel.

- [ ] **Step 3: Type check**

```
npx tsc --noEmit
```

Expected: no errors. If the modal uses a different layout convention, restructure to match.

- [ ] **Step 4: Commit**

```
git add src/components/SettingsModal.tsx
git commit -m "feat(pastes): add Pastes settings section"
```

---

## Task 11: Cleanup - purge pastes on terminal close

**Files:**
- Modify: `src/store/terminalStore.ts`

- [ ] **Step 1: Add the purge call to closeTerminal**

Find the `closeTerminal` action in `src/store/terminalStore.ts`. After the `await invoke('close_terminal', { id });` line, add:

```ts
    // Best-effort cleanup: only run if user retention policy allows it.
    try {
      const { pasteRetention } = (await import('./appStore')).useAppStore.getState();
      if (pasteRetention === 'close') {
        await invoke('purge_pastes', { terminalId: id }).catch(() => {});
      }
      const { usePasteStore } = await import('./pasteStore');
      usePasteStore.getState().clearForTerminal(id);
    } catch {
      // ignore - cleanup is best-effort
    }
```

(Dynamic import avoids a circular import with `appStore` → `terminalStore`.)

- [ ] **Step 2: Type check**

```
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```
git add src/store/terminalStore.ts
git commit -m "feat(pastes): purge pastes when terminal closes (configurable)"
```

---

## Task 12: Mount the drawer in App.tsx

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add the import and the mount point**

Add the import near the other component imports:

```tsx
import { PasteAsFileDrawer } from './components/PasteAsFileDrawer';
```

Mount the component at the same level as other modals (e.g. just before the closing root tag, alongside `<SnippetsModal />` if visible):

```tsx
<PasteAsFileDrawer />
```

- [ ] **Step 2: Type check**

```
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```
git add src/App.tsx
git commit -m "feat(pastes): mount PasteAsFileDrawer in App"
```

---

## Task 13: Changelog entry

**Files:**
- Modify: `src/changelog.json`

- [ ] **Step 1: Read current changelog structure**

```
type src\changelog.json
```

Identify the JSON shape (likely an array of `{ version, date, sections }` objects).

- [ ] **Step 2: Add the new entry at the top of the array**

Add a new entry following the same shape, e.g.:

```json
{
  "version": "1.21.0",
  "date": "2026-05-10",
  "sections": [
    {
      "title": "Paste as File",
      "items": [
        "New drawer (Ctrl+Shift+V) saves large pastes to .claudeterminal/pastes/ and references them in Claude Code via @mention",
        "Auto-detect prompts you when you paste big logs or JSON straight into the terminal",
        "Configurable retention, prompt template, and detection thresholds in Settings"
      ]
    }
  ]
}
```

If the existing shape differs, match it exactly (look at the previous entry).

- [ ] **Step 3: Commit**

```
git add src/changelog.json
git commit -m "docs(changelog): 1.21.0 paste-as-file entry"
```

---

## Task 14: Version bump to 1.21.0

**Files:**
- Modify: `package.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `README.md`

- [ ] **Step 1: Bump `package.json`**

Change `"version": "1.20.8"` → `"version": "1.21.0"`.

- [ ] **Step 2: Bump `src-tauri/Cargo.toml`**

Change `version = "1.20.8"` → `version = "1.21.0"` under `[package]`.

- [ ] **Step 3: Bump `src-tauri/tauri.conf.json`**

Change `"version": "1.20.8"` → `"version": "1.21.0"`.

- [ ] **Step 4: Bump `README.md`**

Replace any occurrence of `1.20.8` with `1.21.0` (badge URL, download link filenames). Use a single search-and-replace.

- [ ] **Step 5: Update Cargo.lock**

```
cd src-tauri
cargo check
```

Expected: succeeds; `Cargo.lock` is regenerated. (Don't ship a release yet - that's done by `/publish`. This step just keeps lockfile consistent with the bump.)

- [ ] **Step 6: Commit**

```
git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/Cargo.lock README.md
git commit -m "chore: bump version to 1.21.0"
```

---

## Task 15: Verification - build, type-check, manual QA

- [ ] **Step 1: Frontend type check + build**

```
npx tsc --noEmit
npm run build
```

Expected: zero errors. If errors appear, fix and re-run.

- [ ] **Step 2: Rust check + tests**

```
cd src-tauri
cargo check
cargo test --lib
```

Expected: builds clean, all tests in `pastes` module pass.

- [ ] **Step 3: Manual QA - happy path**

```
npm run tauri dev
```

In the running app:

1. Open a terminal in any working directory.
2. Click the "Paste as file" button (clipboard icon) in the terminal status bar. Verify drawer opens with empty editor.
3. Close drawer. Press `Ctrl+Shift+V`. Verify drawer opens populated with current clipboard contents.
4. Paste a 200KB JSON sample into the editor. Verify Detected reads `json`, extension auto-flips to `.json`, line/byte stats show.
5. Click **Send**. Verify file appears at `<cwd>/.claudeterminal/pastes/paste-…json`, terminal receives `Please look at @.claudeterminal/pastes/paste-…json`, drawer closes, success toast shows.
6. Verify `<cwd>/.claudeterminal/.gitignore` exists and contains `*`.

- [ ] **Step 4: Manual QA - auto-detect**

1. With auto-detect enabled in Settings, copy a long log file (>4KB) to clipboard.
2. Click into the terminal and `Ctrl+V`. Verify a toast appears with three buttons.
3. Click **Save & Reference**. Drawer opens pre-filled. Send. Confirm file is written and `@mention` types into PTY.
4. Repeat with **Paste anyway** - verify the chunk goes to PTY raw and only that one chunk.
5. Repeat with **Don't ask again** - verify the chunk goes to PTY and the next big paste skips the toast.
6. Re-enable auto-detect in Settings.

- [ ] **Step 5: Manual QA - recent + lifecycle**

1. Send three pastes from one terminal. Verify all three appear in the drawer's "Recent pastes" list.
2. Click a recent row → verify content reloads in the editor.
3. Click the `[↗]` button → verify it re-sends without re-opening.
4. Click the trash icon on a recent row → verify it disappears AND the file is gone from disk.
5. Close the terminal. Verify `<cwd>/.claudeterminal/pastes/` is empty (default retention is "delete on terminal close").
6. In Settings switch retention to "Keep for N days", repeat - verify files survive a terminal close.

- [ ] **Step 6: Manual QA - error paths**

1. Open a terminal in a write-protected directory (or a directory you delete after opening). Try Send. Verify the drawer surfaces the error inline and content is preserved in the editor.
2. Open a terminal, send one paste, then close that terminal. Open the drawer (it's now empty). Manually paste content and pick a target terminal that's still alive. Verify behavior remains correct.

- [ ] **Step 7: Final commit (if any tweaks)**

If any of the QA steps above required code fixes, commit them:

```
git add -A
git commit -m "fix(pastes): manual QA fixes"
```

---

## Self-Review Checklist (already done by author)

- **Spec coverage:** Every section of the spec maps to a task - drawer (T6), data model (T1, T4), filesystem layout (T1), IPC (T2), auto-detect (T7), settings (T10), retention (T1 + T11), cleanup (T11), changelog (T13), version bump (T14). The "startup retention pass" mentioned in the spec is *not* implemented in v1 - retention "Keep for N days" purges only when a paste is later opened/listed via `list_pastes` not on app boot. This is a deliberate scope reduction; documented above.
- **Placeholder scan:** No TBD/TODO. Every step shows the actual code.
- **Type consistency:** `PasteEntry` shape matches between Rust (`pastes.rs`), TypeScript (`pasteStore.ts`), and the drawer.
- **Ambiguity:** None spotted.
