//! Resolves the absolute path to the `claude` binary on macOS / Linux.
//!
//! Why this exists: when the app is launched from Finder/Spotlight on macOS,
//! the spawned PTY's parent env is the launchd env - not the user's shell env.
//! Running `$SHELL -lc 'claude …'` (login + non-interactive) sources `~/.zshenv`
//! and `~/.zprofile` but NOT `~/.zshrc`, where most users actually export their
//! PATH (npm-global prefix, `~/.local/bin`, nvm/fnm/volta init, asdf shims).
//! Result: `claude` is "not found" even though it works fine in their terminal.
//!
//! Fix: resolve the absolute path once via `$SHELL -lic 'command -v claude'`
//! (interactive - sources `.zshrc`), cache it, and use that path directly so
//! later invocations don't depend on the spawned shell's PATH at all.

#[cfg(not(target_os = "windows"))]
use std::sync::{Mutex, OnceLock};

#[cfg(not(target_os = "windows"))]
const VALID_SHELLS: &[&str] = &[
    "/bin/bash", "/bin/sh", "/bin/zsh", "/bin/fish", "/bin/dash",
    "/usr/bin/bash", "/usr/bin/sh", "/usr/bin/zsh", "/usr/bin/fish", "/usr/bin/dash",
    "/usr/local/bin/bash", "/usr/local/bin/zsh", "/usr/local/bin/fish",
    "/opt/homebrew/bin/bash", "/opt/homebrew/bin/zsh", "/opt/homebrew/bin/fish",
];

/// Outer Option = "have we tried to resolve yet"; inner Option = "did we find one".
#[cfg(not(target_os = "windows"))]
fn cache() -> &'static Mutex<Option<Option<String>>> {
    static CELL: OnceLock<Mutex<Option<Option<String>>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

/// Returns the cached absolute path to `claude`, resolving on first call.
/// Re-resolves if the cached path no longer exists on disk (user uninstalled
/// and reinstalled in a different location). Returns `None` if claude can't
/// be located - callers should fall back to a shell-PATH lookup.
///
/// On Windows this always returns `None` because `cmd /C claude` already
/// resolves `claude.cmd`/`claude.ps1` correctly via PATHEXT.
#[cfg(target_os = "windows")]
pub fn cached() -> Option<String> {
    None
}

#[cfg(not(target_os = "windows"))]
pub fn cached() -> Option<String> {
    {
        let guard = cache().lock().unwrap();
        if let Some(opt) = guard.as_ref() {
            match opt {
                Some(path) if std::path::Path::new(path).is_file() => {
                    return Some(path.clone());
                }
                None => return None,
                // Cached path no longer on disk - fall through to re-resolve.
                Some(_) => {}
            }
        }
    }
    let resolved = resolve();
    *cache().lock().unwrap() = Some(resolved.clone());
    resolved
}

/// Drop the cached path so the next `cached()` call re-resolves. Call this
/// after `npm install -g @anthropic-ai/claude-code` succeeds.
#[cfg(target_os = "windows")]
pub fn invalidate() {}

#[cfg(not(target_os = "windows"))]
pub fn invalidate() {
    *cache().lock().unwrap() = None;
}

#[cfg(not(target_os = "windows"))]
fn resolve() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
    let shell = if VALID_SHELLS.contains(&shell.as_str()) {
        shell
    } else {
        "/bin/bash".to_string()
    };

    // -lic = login + interactive + run-command. The `-i` is what gets `.zshrc`
    // sourced. Redirect stderr to /dev/null so prompt-init complaints (e.g.
    // p10k "instant prompt configured for X user") don't pollute the output
    // we're about to parse - `command -v` only writes to stdout.
    let output = std::process::Command::new(&shell)
        .arg("-lic")
        .arg("command -v claude 2>/dev/null")
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let path = parse_command_v_output(&stdout)?;
    if std::path::Path::new(path).is_file() {
        Some(path.to_string())
    } else {
        None
    }
}

/// Pure parser: pick the last line in `stdout` that looks like an absolute
/// path to a `claude` binary. Tolerant of init noise that .zshrc / .bashrc
/// may print before `command -v` runs (banners, conda init blurbs, etc.).
///
/// Rejects:
/// - aliases (`alias claude='…'`)
/// - functions/builtins (just the name `claude`)
/// - relative paths
#[allow(dead_code)] // Called by resolve() on Unix; covered by tests on all platforms.
fn parse_command_v_output(stdout: &str) -> Option<&str> {
    for line in stdout.lines().rev() {
        let trimmed = line.trim();
        if trimmed.starts_with('/') && trimmed.ends_with("/claude") {
            return Some(trimmed);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_path() {
        assert_eq!(
            parse_command_v_output("/Users/foo/.local/bin/claude\n"),
            Some("/Users/foo/.local/bin/claude")
        );
    }

    #[test]
    fn parses_homebrew_path() {
        assert_eq!(
            parse_command_v_output("/opt/homebrew/bin/claude"),
            Some("/opt/homebrew/bin/claude")
        );
    }

    #[test]
    fn ignores_init_noise_before_path() {
        let out = "p10k: instant prompt loaded\n\
                   Welcome back, foo!\n\
                   /Users/foo/.npm-global/bin/claude\n";
        assert_eq!(
            parse_command_v_output(out),
            Some("/Users/foo/.npm-global/bin/claude")
        );
    }

    #[test]
    fn picks_last_path_when_multiple() {
        // Defensive: if the user has multiple shell rc files each printing a
        // path-like line, take the *last* (the one printed by `command -v`,
        // which runs after all init).
        let out = "/old/path/claude\n/new/path/claude\n";
        assert_eq!(
            parse_command_v_output(out),
            Some("/new/path/claude")
        );
    }

    #[test]
    fn rejects_alias_output() {
        // zsh prints `claude: aliased to …` for aliases - no leading slash.
        assert_eq!(
            parse_command_v_output("claude: aliased to /some/wrapper\n"),
            None
        );
    }

    #[test]
    fn rejects_builtin_or_function() {
        // `command -v` for a function/builtin prints just the name.
        assert_eq!(parse_command_v_output("claude\n"), None);
    }

    #[test]
    fn rejects_relative_path() {
        assert_eq!(parse_command_v_output("./bin/claude\n"), None);
    }

    #[test]
    fn rejects_unrelated_path() {
        // Defensive: parser must end in /claude specifically, not just any
        // word starting with claude (e.g. /usr/bin/claude-helper).
        assert_eq!(
            parse_command_v_output("/usr/bin/claude-helper\n"),
            None
        );
    }

    #[test]
    fn empty_output_returns_none() {
        assert_eq!(parse_command_v_output(""), None);
        assert_eq!(parse_command_v_output("\n\n"), None);
    }
}
