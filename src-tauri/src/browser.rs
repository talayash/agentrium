//! Built-in browser: each browser tab is a native child webview (WebView2 on
//! Windows, WKWebView on macOS) attached to the main window and positioned
//! over the React "page slot" by the frontend.
//!
//! Security model:
//! - Tabs only ever load http(s). Every navigation (typed, link click,
//!   redirect, popup) passes `nav_decision`, which also refuses the app's own
//!   origins so a tab can never become a second copy of Agentrium with its
//!   IPC capabilities (remote origins get no capability grant).
//! - Popups never open a native window; they become a new tab in the UI.
//! - Downloads are refused for now and reported to the UI.
//! - Tabs use their own browser profile directory, so site cookies and
//!   storage never mix with the app webview's own storage.

use serde::{Deserialize, Serialize};
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};

use crate::commands::wrap_cmd;
use crate::error_reporter::user_err;

const LABEL_PREFIX: &str = "browser-";
const HOST_WINDOW: &str = "main";
/// Single event channel for every tab; the payload carries the tab id.
pub const BROWSER_EVENT: &str = "browser-event";

/// Page-slot rectangle in logical (CSS) pixels relative to the main window's
/// client area - exactly what `getBoundingClientRect()` returns.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BrowserEvent {
    LoadStarted {
        id: String,
        url: String,
    },
    LoadFinished {
        id: String,
        url: String,
    },
    TitleChanged {
        id: String,
        title: String,
    },
    LoadFailed {
        id: String,
        url: String,
        error: String,
    },
    /// A page asked for a popup / `target=_blank`; the UI opens it as a tab.
    NewTab {
        id: String,
        url: String,
    },
    Blocked {
        id: String,
        url: String,
        reason: String,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub enum NavDecision {
    Allow,
    Block(&'static str),
}

/// Decide whether a tab may load `url`. `app_origins` are the origins the
/// Agentrium UI itself is served from (the Vite dev server in debug builds).
pub fn nav_decision(url: &Url, app_origins: &[String]) -> NavDecision {
    match url.scheme() {
        "http" | "https" => {}
        "about" if url.as_str() == "about:blank" => return NavDecision::Allow,
        _ => return NavDecision::Block("Only http and https pages can open in the browser."),
    }
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    if host == "tauri.localhost" || host == "ipc.localhost" {
        return NavDecision::Block("Agentrium's internal pages can't open in the browser.");
    }
    let origin = url.origin().ascii_serialization();
    if app_origins.contains(&origin) {
        return NavDecision::Block("Agentrium itself can't open in its own browser.");
    }
    NavDecision::Allow
}

/// Parse an address the frontend already normalised (scheme added, search
/// turned into a search URL). Anything else is a user error, not a bug.
pub fn parse_tab_url(raw: &str, app_origins: &[String]) -> Result<Url, String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.contains('\0') {
        return Err(user_err("Invalid URL"));
    }
    let url = Url::parse(raw).map_err(|_| user_err("Invalid URL"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(user_err(
            "Only http and https pages can open in the browser.",
        ));
    }
    match nav_decision(&url, app_origins) {
        NavDecision::Allow => Ok(url),
        NavDecision::Block(reason) => Err(user_err(reason)),
    }
}

/// Tab ids come from the frontend and become webview labels, so keep them to
/// a small, label-safe alphabet.
pub fn validate_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err("Invalid browser tab id".to_string())
    }
}

fn label(id: &str) -> String {
    format!("{LABEL_PREFIX}{id}")
}

fn app_origins(app: &AppHandle) -> Vec<String> {
    // Production serves the UI from tauri://localhost / http://tauri.localhost,
    // which nav_decision already refuses. Only debug builds load the UI from
    // devUrl; in release builds that port may be the user's own dev server.
    if cfg!(debug_assertions) {
        if let Some(dev) = app.config().build.dev_url.as_ref() {
            return vec![dev.origin().ascii_serialization()];
        }
    }
    Vec::new()
}

fn emit(app: &AppHandle, event: BrowserEvent) {
    // Best effort: the only listener is the main window's UI.
    let _ = app.emit_to(HOST_WINDOW, BROWSER_EVENT, event);
}

fn get_tab(app: &AppHandle, id: &str) -> Result<tauri::Webview, String> {
    validate_id(id)?;
    app.get_webview(&label(id))
        .ok_or_else(|| user_err("This tab is no longer open."))
}

fn create_tab(app: &AppHandle, id: &str, url: Url, bounds: Bounds) -> Result<(), String> {
    let window = app
        .get_window(HOST_WINDOW)
        .ok_or_else(|| "Main window not found".to_string())?;
    let origins = app_origins(app);

    let nav_app = app.clone();
    let nav_id = id.to_string();
    let nav_origins = origins.clone();
    let load_app = app.clone();
    let load_id = id.to_string();
    let title_app = app.clone();
    let title_id = id.to_string();
    let popup_app = app.clone();
    let popup_id = id.to_string();
    let dl_app = app.clone();
    let dl_id = id.to_string();

    let mut builder = WebviewBuilder::new(label(id), WebviewUrl::External(url))
        .on_navigation(move |u| match nav_decision(u, &nav_origins) {
            NavDecision::Allow => true,
            NavDecision::Block(reason) => {
                emit(
                    &nav_app,
                    BrowserEvent::Blocked { id: nav_id.clone(), url: u.to_string(), reason: reason.into() },
                );
                false
            }
        })
        .on_page_load(move |_wv, payload| {
            let id = load_id.clone();
            let url = payload.url().to_string();
            let event = match payload.event() {
                PageLoadEvent::Started => BrowserEvent::LoadStarted { id, url },
                PageLoadEvent::Finished => BrowserEvent::LoadFinished { id, url },
            };
            emit(&load_app, event);
        })
        .on_document_title_changed(move |_wv, title| {
            emit(&title_app, BrowserEvent::TitleChanged { id: title_id.clone(), title });
        })
        .on_new_window(move |u, _features| {
            let event = match nav_decision(&u, &origins) {
                NavDecision::Allow => BrowserEvent::NewTab { id: popup_id.clone(), url: u.to_string() },
                NavDecision::Block(reason) => {
                    BrowserEvent::Blocked { id: popup_id.clone(), url: u.to_string(), reason: reason.into() }
                }
            };
            emit(&popup_app, event);
            NewWindowResponse::Deny
        })
        .on_download(move |_wv, event| {
            if let DownloadEvent::Requested { url, .. } = event {
                emit(
                    &dl_app,
                    BrowserEvent::Blocked {
                        id: dl_id.clone(),
                        url: url.to_string(),
                        reason: "Downloads aren't supported in the built-in browser yet. Open the page in your default browser to download.".into(),
                    },
                );
            }
            false
        });

    if let Ok(dir) = app.path().app_local_data_dir() {
        builder = builder.data_directory(dir.join("browser-profile"));
    }

    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)),
        )
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "windows")]
    watch_load_errors(app, &webview, id);
    #[cfg(not(target_os = "windows"))]
    let _ = webview;

    Ok(())
}

/// WebView2 reports failed navigations (DNS, refused connection, TLS) only
/// through NavigationCompleted; Tauri's page-load event still says
/// "finished". Forward the failure so the UI can show its own error card.
#[cfg(target_os = "windows")]
fn watch_load_errors(app: &AppHandle, webview: &tauri::Webview, id: &str) {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::NavigationCompletedEventHandler;

    let app = app.clone();
    let id = id.to_string();
    let _ = webview.with_webview(move |platform| unsafe {
        let Ok(core) = platform.controller().CoreWebView2() else {
            return;
        };
        let handler = NavigationCompletedEventHandler::create(Box::new(move |sender, args| {
            let Some(args) = args else { return Ok(()) };
            let mut ok = windows_core::BOOL::default();
            args.IsSuccess(&mut ok)?;
            if ok.as_bool() {
                return Ok(());
            }
            let mut status = COREWEBVIEW2_WEB_ERROR_STATUS::default();
            args.WebErrorStatus(&mut status)?;
            // Cancelled = the user (or the page) started another navigation.
            if status == COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED {
                return Ok(());
            }
            let mut url = String::new();
            if let Some(sender) = sender {
                let mut raw = windows_core::PWSTR::null();
                if sender.Source(&mut raw).is_ok() {
                    url = webview2_com::take_pwstr(raw);
                }
            }
            emit(
                &app,
                BrowserEvent::LoadFailed {
                    id: id.clone(),
                    url,
                    error: describe_web_error(status).into(),
                },
            );
            Ok(())
        }));
        let mut token = 0i64;
        let _ = core.add_NavigationCompleted(&handler, &mut token);
    });
}

#[cfg(target_os = "windows")]
fn describe_web_error(
    status: webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_WEB_ERROR_STATUS,
) -> &'static str {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    match status {
        COREWEBVIEW2_WEB_ERROR_STATUS_CANNOT_CONNECT => "The site refused the connection.",
        COREWEBVIEW2_WEB_ERROR_STATUS_HOST_NAME_NOT_RESOLVED => {
            "The site's address couldn't be found."
        }
        COREWEBVIEW2_WEB_ERROR_STATUS_TIMEOUT => "The site took too long to respond.",
        COREWEBVIEW2_WEB_ERROR_STATUS_DISCONNECTED => "You appear to be offline.",
        COREWEBVIEW2_WEB_ERROR_STATUS_SERVER_UNREACHABLE => "The server couldn't be reached.",
        COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_ABORTED
        | COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_RESET => "The connection was interrupted.",
        COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_COMMON_NAME_IS_INCORRECT
        | COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_EXPIRED
        | COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_IS_INVALID
        | COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_REVOKED => {
            "The site's security certificate isn't valid."
        }
        COREWEBVIEW2_WEB_ERROR_STATUS_REDIRECT_FAILED => "The site redirected too many times.",
        _ => "The page couldn't be loaded.",
    }
}

#[tauri::command]
pub async fn browser_navigate(
    app: AppHandle,
    id: String,
    url: String,
    bounds: Bounds,
) -> Result<(), String> {
    wrap_cmd("browser_navigate", async move {
        validate_id(&id)?;
        let target = parse_tab_url(&url, &app_origins(&app))?;
        match app.get_webview(&label(&id)) {
            Some(webview) => webview.navigate(target).map_err(|e| e.to_string()),
            None => create_tab(&app, &id, target, bounds),
        }
    })
    .await
}

#[tauri::command]
pub async fn browser_back(app: AppHandle, id: String) -> Result<(), String> {
    wrap_cmd("browser_back", async move {
        get_tab(&app, &id)?
            .eval("history.back()")
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn browser_forward(app: AppHandle, id: String) -> Result<(), String> {
    wrap_cmd("browser_forward", async move {
        get_tab(&app, &id)?
            .eval("history.forward()")
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn browser_reload(app: AppHandle, id: String) -> Result<(), String> {
    wrap_cmd("browser_reload", async move {
        get_tab(&app, &id)?.reload().map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn browser_set_bounds(app: AppHandle, id: String, bounds: Bounds) -> Result<(), String> {
    wrap_cmd("browser_set_bounds", async move {
        let webview = get_tab(&app, &id)?;
        webview
            .set_position(LogicalPosition::new(bounds.x, bounds.y))
            .and_then(|_| {
                webview.set_size(LogicalSize::new(
                    bounds.width.max(1.0),
                    bounds.height.max(1.0),
                ))
            })
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn browser_set_visible(app: AppHandle, id: String, visible: bool) -> Result<(), String> {
    wrap_cmd("browser_set_visible", async move {
        let webview = get_tab(&app, &id)?;
        let res = if visible {
            webview.show()
        } else {
            webview.hide()
        };
        res.map_err(|e| e.to_string())
    })
    .await
}

/// Closing a tab that has no webview yet (an empty "New tab") is a no-op.
#[tauri::command]
pub async fn browser_close(app: AppHandle, id: String) -> Result<(), String> {
    wrap_cmd("browser_close", async move {
        validate_id(&id)?;
        match app.get_webview(&label(&id)) {
            Some(webview) => webview.close().map_err(|e| e.to_string()),
            None => Ok(()),
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error_reporter::{is_user_error, strip_user_prefix};

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn allows_http_and_https() {
        assert_eq!(
            nav_decision(&u("https://example.com/a?b=1"), &[]),
            NavDecision::Allow
        );
        assert_eq!(
            nav_decision(&u("http://localhost:3000/"), &[]),
            NavDecision::Allow
        );
        assert_eq!(nav_decision(&u("about:blank"), &[]), NavDecision::Allow);
    }

    #[test]
    fn blocks_non_web_schemes() {
        for s in [
            "agentrium://auth-return?code=x&state=y",
            "file:///C:/Windows/win.ini",
            "javascript:alert(1)",
            "tauri://localhost/",
            "about:config",
            "data:text/html,hi",
        ] {
            assert!(
                matches!(nav_decision(&u(s), &[]), NavDecision::Block(_)),
                "{s} should be blocked"
            );
        }
    }

    #[test]
    fn blocks_tauri_internal_hosts() {
        assert!(matches!(
            nav_decision(&u("http://tauri.localhost/index.html"), &[]),
            NavDecision::Block(_)
        ));
        assert!(matches!(
            nav_decision(&u("http://ipc.localhost/plugin"), &[]),
            NavDecision::Block(_)
        ));
    }

    #[test]
    fn blocks_app_origin_but_not_other_ports() {
        let origins = vec!["http://localhost:5173".to_string()];
        assert!(matches!(
            nav_decision(&u("http://localhost:5173/settings"), &origins),
            NavDecision::Block(_)
        ));
        assert_eq!(
            nav_decision(&u("http://localhost:5174/"), &origins),
            NavDecision::Allow
        );
    }

    #[test]
    fn parse_tab_url_rejects_bad_input_as_user_errors() {
        for raw in [
            "",
            "   ",
            "not a url",
            "ftp://example.com",
            "agentrium://x",
            "https://exa\0mple.com",
        ] {
            let err = parse_tab_url(raw, &[]).unwrap_err();
            assert!(
                is_user_error(&err),
                "{raw:?} should be a user error, got {err}"
            );
        }
        assert_eq!(
            parse_tab_url(" https://example.com ", &[])
                .unwrap()
                .as_str(),
            "https://example.com/"
        );
    }

    #[test]
    fn parse_tab_url_reports_block_reason() {
        let err = parse_tab_url("http://tauri.localhost/", &[]).unwrap_err();
        assert!(strip_user_prefix(&err).contains("internal pages"));
    }

    #[test]
    fn validate_id_accepts_label_safe_ids_only() {
        assert!(validate_id("tab-1_a").is_ok());
        assert!(validate_id("").is_err());
        assert!(validate_id("a/b").is_err());
        assert!(validate_id("main").is_ok());
        assert!(validate_id(&"x".repeat(65)).is_err());
    }

    #[test]
    fn events_serialize_with_camel_case_kind() {
        let json = serde_json::to_value(BrowserEvent::LoadFailed {
            id: "t1".into(),
            url: "http://localhost:3000/".into(),
            error: "refused".into(),
        })
        .unwrap();
        assert_eq!(json["kind"], "loadFailed");
        assert_eq!(json["id"], "t1");
    }
}
