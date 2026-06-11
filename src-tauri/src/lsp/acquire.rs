//! Language-server discovery and installation.
//! Order: binary on PATH → app-data install dir → Missing (settings page
//! offers Install). Claude Code's own LSP plugins use PATH-only; we go one
//! step further and self-install like Zed/mason.

use std::path::PathBuf;

pub struct ServerSpec {
    /// Our language key: "typescript" | "python" | "rust".
    pub language: &'static str,
    /// Binary name probed on PATH and produced by install.
    pub bin: &'static str,
    pub args: &'static [&'static str],
    /// npm packages to `npm install --prefix <data>/lsp-servers`, empty for
    /// GitHub-release downloads (rust-analyzer).
    pub npm_packages: &'static [&'static str],
}

pub fn server_spec(language: &str) -> Option<ServerSpec> {
    match language {
        "typescript" => Some(ServerSpec {
            language: "typescript",
            bin: "typescript-language-server",
            args: &["--stdio"],
            npm_packages: &["typescript-language-server", "typescript"],
        }),
        "python" => Some(ServerSpec {
            language: "python",
            bin: "pyright-langserver",
            args: &["--stdio"],
            npm_packages: &["pyright"],
        }),
        "rust" => Some(ServerSpec {
            language: "rust",
            bin: "rust-analyzer",
            args: &[],
            npm_packages: &[],
        }),
        _ => None,
    }
}

pub fn lsp_data_dir() -> PathBuf {
    directories::ProjectDirs::from("com", "claudeterminal", "ClaudeTerminal")
        .map(|d| d.data_dir().join("lsp-servers"))
        .unwrap_or_else(|| PathBuf::from("lsp-servers"))
}

pub fn installed_bin_path(spec: &ServerSpec) -> PathBuf {
    let dir = lsp_data_dir();
    if spec.npm_packages.is_empty() {
        // GitHub-release binary layout: lsp-servers/bin/<bin>[.exe]
        let name = if cfg!(target_os = "windows") {
            format!("{}.exe", spec.bin)
        } else {
            spec.bin.to_string()
        };
        dir.join("bin").join(name)
    } else {
        let name = if cfg!(target_os = "windows") {
            format!("{}.cmd", spec.bin)
        } else {
            spec.bin.to_string()
        };
        dir.join("node_modules").join(".bin").join(name)
    }
}

#[derive(serde::Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Resolution {
    /// `program` is what we pass to LspClient::spawn.
    Path { program: String, version: Option<String> },
    Installed { program: String },
    Missing,
}

/// PATH probe + install-dir check. Blocking (runs `--version`); call via
/// tokio::task::spawn_blocking from async contexts.
pub fn resolve(language: &str) -> Result<(ServerSpec, Resolution), String> {
    let spec = server_spec(language).ok_or_else(|| format!("unknown language {language}"))?;
    // 1) PATH
    let probe = crate::commands::shell_command(spec.bin, &["--version"]).output();
    if let Ok(out) = probe {
        if out.status.success() {
            let version = String::from_utf8_lossy(&out.stdout).lines().next().map(|s| s.trim().to_string());
            let resolution = Resolution::Path { program: spec.bin.to_string(), version };
            return Ok((spec, resolution));
        }
    }
    // 2) install dir
    let installed = installed_bin_path(&spec);
    if installed.exists() {
        let resolution = Resolution::Installed { program: installed.to_string_lossy().to_string() };
        return Ok((spec, resolution));
    }
    Ok((spec, Resolution::Missing))
}

/// Install the server for `language` into the app data dir.
pub async fn install(language: &str) -> Result<(), String> {
    let spec = server_spec(language).ok_or_else(|| format!("unknown language {language}"))?;
    let dir = lsp_data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if spec.npm_packages.is_empty() {
        install_rust_analyzer(&dir).await
    } else {
        let mut args: Vec<String> = vec!["install".into(), "--prefix".into(), dir.to_string_lossy().to_string()];
        args.extend(spec.npm_packages.iter().map(|s| s.to_string()));
        let out = tokio::task::spawn_blocking(move || {
            let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
            crate::commands::shell_command("npm", &arg_refs).output()
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).to_string())
        }
    }
}

fn ra_asset() -> Result<(&'static str, bool), String> {
    // (asset name, is_zip)
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        Ok(("rust-analyzer-x86_64-pc-windows-msvc.zip", true))
    } else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
        Ok(("rust-analyzer-aarch64-pc-windows-msvc.zip", true))
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Ok(("rust-analyzer-aarch64-apple-darwin.gz", false))
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        Ok(("rust-analyzer-x86_64-apple-darwin.gz", false))
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Ok(("rust-analyzer-x86_64-unknown-linux-gnu.gz", false))
    } else {
        Err("no rust-analyzer build for this platform — install it on PATH instead".into())
    }
}

async fn install_rust_analyzer(dir: &std::path::Path) -> Result<(), String> {
    let (asset, is_zip) = ra_asset()?;
    let url = format!(
        "https://github.com/rust-lang/rust-analyzer/releases/latest/download/{asset}"
    );
    let bytes = reqwest::get(&url)
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;

    let bin_dir = dir.join("bin");
    let target = installed_bin_path(&server_spec("rust").unwrap());
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        std::fs::create_dir_all(&bin_dir).map_err(|e| e.to_string())?;
        let mut out = std::fs::File::create(&target).map_err(|e| e.to_string())?;
        if is_zip {
            let reader = std::io::Cursor::new(bytes.as_ref().to_vec());
            let mut zip = zip::ZipArchive::new(reader).map_err(|e| e.to_string())?;
            let mut entry = zip.by_index(0).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        } else {
            let mut gz = flate2::read::GzDecoder::new(bytes.as_ref());
            std::io::copy(&mut gz, &mut out).map_err(|e| e.to_string())?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// rust-analyzer needs the directory containing Cargo.toml, not the git root
/// (this repo's Cargo.toml lives in src-tauri/, not the repo root). Walk up
/// from the file toward `fallback`; return the first dir with a Cargo.toml,
/// else `fallback`.
pub fn rust_project_root(file_path: &str, fallback: &str) -> String {
    let mut dir = std::path::Path::new(file_path).parent();
    let stop = std::path::Path::new(fallback);
    while let Some(d) = dir {
        if d.join("Cargo.toml").exists() {
            return d.to_string_lossy().to_string();
        }
        if d == stop {
            break;
        }
        dir = d.parent();
    }
    fallback.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_languages_have_specs() {
        for lang in ["typescript", "python", "rust"] {
            assert!(server_spec(lang).is_some(), "missing spec for {lang}");
        }
        assert!(server_spec("cobol").is_none());
    }

    #[test]
    fn npm_bin_path_is_under_data_dir() {
        let spec = server_spec("typescript").unwrap();
        let p = installed_bin_path(&spec);
        let s = p.to_string_lossy().replace('\\', "/");
        assert!(s.contains("lsp-servers"), "got {s}");
        if cfg!(target_os = "windows") {
            assert!(s.ends_with("typescript-language-server.cmd"), "got {s}");
        } else {
            assert!(s.ends_with("typescript-language-server"), "got {s}");
        }
    }

    #[test]
    fn rust_project_root_walks_up_to_cargo_toml() {
        let tmp = tempfile::tempdir().unwrap();
        let crate_dir = tmp.path().join("backend");
        let nested = crate_dir.join("src").join("deep");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(crate_dir.join("Cargo.toml"), "[package]").unwrap();
        let file = nested.join("main.rs");
        std::fs::write(&file, "fn main(){}").unwrap();

        let root = rust_project_root(file.to_str().unwrap(), tmp.path().to_str().unwrap());
        assert_eq!(root, crate_dir.to_string_lossy().to_string());
    }

    #[test]
    fn rust_project_root_falls_back_when_no_cargo_toml() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("loose.rs");
        std::fs::write(&file, "").unwrap();
        let root = rust_project_root(file.to_str().unwrap(), tmp.path().to_str().unwrap());
        assert_eq!(root, tmp.path().to_string_lossy().to_string());
    }
}
