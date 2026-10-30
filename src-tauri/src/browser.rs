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

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

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
    /// The user picked an element with the armed picker.
    ElementPicked {
        id: String,
        element: PickedElement,
    },
    /// The armed picker ended without a pick (Esc, or a forged pick URL).
    PickCancelled {
        id: String,
    },
}

/// What the element picker reports. Every field is page-controlled text, so
/// it is length-capped here and only ever shown to the user to review.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PickedElement {
    pub url: String,
    pub title: String,
    pub selector: String,
    pub tag: String,
    pub text: String,
    pub html: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PickOutcome {
    NotPick,
    Picked(PickedElement),
    Cancelled,
    Rejected,
}

/// The injected picker script reports by navigating to this scheme; the tab's
/// `on_navigation` intercepts and cancels it, so it never loads anything.
pub const PICK_SCHEME: &str = "agentrium-pick";
/// Upper bound for a whole pick URL; the script trims `html` to fit.
const MAX_PICK_URL_LEN: usize = 32 * 1024;

fn cap_chars(mut s: String, max: usize) -> String {
    if let Some((i, _)) = s.char_indices().nth(max) {
        s.truncate(i);
    }
    s
}

/// Parse a navigation to `agentrium-pick://pick?n=<nonce>&d=<json>` or
/// `agentrium-pick://cancel?n=<nonce>`. Anything without the armed tab's
/// nonce is `Rejected`, so a page can't forge a pick unless the picker is on.
pub fn parse_pick_url(u: &Url, armed_nonce: Option<&str>) -> PickOutcome {
    if u.scheme() != PICK_SCHEME {
        return PickOutcome::NotPick;
    }
    let Some(armed) = armed_nonce.filter(|n| !n.is_empty()) else {
        return PickOutcome::Rejected;
    };
    if u.as_str().len() > MAX_PICK_URL_LEN {
        return PickOutcome::Rejected;
    }
    let mut nonce = None;
    let mut data = None;
    for (k, v) in u.query_pairs() {
        match k.as_ref() {
            "n" => nonce = Some(v.into_owned()),
            "d" => data = Some(v.into_owned()),
            _ => {}
        }
    }
    if nonce.as_deref() != Some(armed) {
        return PickOutcome::Rejected;
    }
    match u.host_str() {
        Some("cancel") => PickOutcome::Cancelled,
        Some("pick") => {
            let Some(Ok(el)) = data.map(|d| serde_json::from_str::<PickedElement>(&d)) else {
                return PickOutcome::Rejected;
            };
            PickOutcome::Picked(PickedElement {
                url: cap_chars(el.url, 2048),
                title: cap_chars(el.title, 300),
                selector: cap_chars(el.selector, 500),
                tag: cap_chars(el.tag, 64),
                text: cap_chars(el.text, 500),
                html: cap_chars(el.html, 4000),
            })
        }
        _ => PickOutcome::Rejected,
    }
}

/// Tab id -> nonce of the picker currently armed in that tab.
fn armed_pickers() -> &'static Mutex<HashMap<String, String>> {
    static ARMED: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    ARMED.get_or_init(Default::default)
}

fn arm_picker(id: &str, nonce: String) {
    armed_pickers()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id.to_string(), nonce);
}

fn disarm_picker(id: &str) -> Option<String> {
    armed_pickers()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(id)
}

/// Transport-independent half of the picker channel. `None` means `u` is not
/// a picker URL and normal navigation rules apply. Otherwise the tab is
/// disarmed (any picker URL, valid or not, ends the pick, so a page gets one
/// guess per arm) and the result holds the event to emit, if any.
fn take_pick(id: &str, u: &Url) -> Option<Option<BrowserEvent>> {
    if u.scheme() != PICK_SCHEME {
        return None;
    }
    let armed = disarm_picker(id);
    let id = id.to_string();
    Some(match parse_pick_url(u, armed.as_deref()) {
        PickOutcome::NotPick => None,
        PickOutcome::Picked(element) => Some(BrowserEvent::ElementPicked { id, element }),
        PickOutcome::Cancelled => Some(BrowserEvent::PickCancelled { id }),
        // Only tell the UI when it was actually waiting on this tab.
        PickOutcome::Rejected => armed.map(|_| BrowserEvent::PickCancelled { id }),
    })
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
        .on_navigation(move |u| {
            // Picker reports come before nav_decision and never load.
            if let Some(event) = take_pick(&nav_id, u) {
                if let Some(event) = event {
                    emit(&nav_app, event);
                }
                return false;
            }
            match nav_decision(u, &nav_origins) {
                NavDecision::Allow => true,
                NavDecision::Block(reason) => {
                    emit(
                        &nav_app,
                        BrowserEvent::Blocked { id: nav_id.clone(), url: u.to_string(), reason: reason.into() },
                    );
                    false
                }
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
        disarm_picker(&id);
        match app.get_webview(&label(&id)) {
            Some(webview) => webview.close().map_err(|e| e.to_string()),
            None => Ok(()),
        }
    })
    .await
}

/// Arm the element picker in one tab: a fresh nonce, then the picker script.
/// The page reports back only through a `PICK_SCHEME` navigation carrying
/// that nonce; tabs never get an IPC path.
#[tauri::command]
pub async fn browser_pick_element(app: AppHandle, id: String) -> Result<(), String> {
    wrap_cmd("browser_pick_element", async move {
        let webview = get_tab(&app, &id)?;
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        arm_picker(&id, nonce.clone());
        let script = include_str!("browser_picker.js").replace("__NONCE__", &nonce);
        webview.eval(&script).map_err(|e| {
            disarm_picker(&id);
            e.to_string()
        })
    })
    .await
}

#[tauri::command]
pub async fn browser_cancel_pick(app: AppHandle, id: String) -> Result<(), String> {
    wrap_cmd("browser_cancel_pick", async move {
        validate_id(&id)?;
        disarm_picker(&id);
        // Best effort: the tab may have closed or navigated (script gone).
        if let Some(webview) = app.get_webview(&label(&id)) {
            let _ = webview.eval("window.__agentriumPick && window.__agentriumPick.cancel()");
        }
        Ok(())
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

        let picked = serde_json::to_value(BrowserEvent::ElementPicked {
            id: "t1".into(),
            element: PickedElement::default(),
        })
        .unwrap();
        assert_eq!(picked["kind"], "elementPicked");
        assert_eq!(picked["element"]["selector"], "");
        let cancelled = serde_json::to_value(BrowserEvent::PickCancelled { id: "t1".into() }).unwrap();
        assert_eq!(cancelled["kind"], "pickCancelled");
    }

    fn pick_url(nonce: &str, payload: &serde_json::Value) -> Url {
        let mut url = u(&format!("agentrium-pick://pick?n={nonce}"));
        url.query_pairs_mut().append_pair("d", &payload.to_string());
        url
    }

    #[test]
    fn pick_url_without_armed_nonce_is_dropped() {
        let url = u("agentrium-pick://pick?n=abc&d=%7B%7D");
        assert_eq!(parse_pick_url(&url, None), PickOutcome::Rejected);
        assert_eq!(parse_pick_url(&url, Some("zzz")), PickOutcome::Rejected);
        let cancel = u("agentrium-pick://cancel?n=abc");
        assert_eq!(parse_pick_url(&cancel, None), PickOutcome::Rejected);
        // An empty armed nonce never matches a missing one.
        assert_eq!(parse_pick_url(&u("agentrium-pick://pick?d=%7B%7D"), Some("")), PickOutcome::Rejected);
    }

    #[test]
    fn pick_url_parses_and_truncates() {
        let payload = serde_json::json!({
            "url": "https://example.com/a",
            "title": "Example",
            "selector": "é".repeat(600),
            "tag": "button",
            "text": "ü".repeat(700),
            "html": "<b>".repeat(2000),
        });
        let PickOutcome::Picked(el) = parse_pick_url(&pick_url("abc", &payload), Some("abc")) else {
            panic!("expected a pick");
        };
        assert_eq!(el.url, "https://example.com/a");
        assert_eq!(el.title, "Example");
        assert_eq!(el.tag, "button");
        assert_eq!(el.selector.chars().count(), 500);
        assert_eq!(el.text.chars().count(), 500);
        assert_eq!(el.html.chars().count(), 4000);
    }

    #[test]
    fn pick_url_with_bad_payload_is_rejected() {
        let url = u("agentrium-pick://pick?n=abc&d=not-json");
        assert_eq!(parse_pick_url(&url, Some("abc")), PickOutcome::Rejected);
        let other = u("agentrium-pick://elsewhere?n=abc");
        assert_eq!(parse_pick_url(&other, Some("abc")), PickOutcome::Rejected);
    }

    #[test]
    fn pick_cancel_url() {
        assert_eq!(
            parse_pick_url(&u("agentrium-pick://cancel?n=abc"), Some("abc")),
            PickOutcome::Cancelled
        );
    }

    #[test]
    fn non_pick_url_is_not_pick() {
        assert_eq!(parse_pick_url(&u("https://example.com"), Some("abc")), PickOutcome::NotPick);
        assert_eq!(parse_pick_url(&u("https://example.com"), None), PickOutcome::NotPick);
    }

    #[test]
    fn oversized_pick_payload_is_rejected() {
        let payload = serde_json::json!({ "html": "x".repeat(33 * 1024) });
        assert_eq!(
            parse_pick_url(&pick_url("abc", &payload), Some("abc")),
            PickOutcome::Rejected
        );
    }

    #[test]
    fn pick_navigation_disarms_and_never_allows() {
        let id = "pick-test-tab";
        arm_picker(id, "abc".into());
        let cancel = u("agentrium-pick://cancel?n=abc");
        assert!(matches!(
            take_pick(id, &cancel),
            Some(Some(BrowserEvent::PickCancelled { .. }))
        ));
        // Disarmed: a replay of the same URL yields nothing.
        assert!(matches!(take_pick(id, &cancel), Some(None)));
        // A wrong nonce still disarms, so a page gets one guess per arm.
        arm_picker(id, "abc".into());
        assert!(matches!(
            take_pick(id, &u("agentrium-pick://cancel?n=zzz")),
            Some(Some(BrowserEvent::PickCancelled { .. }))
        ));
        assert!(matches!(take_pick(id, &cancel), Some(None)));
        // Ordinary pages are left to nav_decision.
        assert!(take_pick(id, &u("https://example.com/")).is_none());
        // The pick scheme itself is never an allowed navigation.
        assert!(matches!(nav_decision(&cancel, &[]), NavDecision::Block(_)));
    }

    #[test]
    fn disarm_removes_the_nonce() {
        let id = "pick-test-disarm";
        arm_picker(id, "abc".into());
        disarm_picker(id);
        assert!(matches!(take_pick(id, &u("agentrium-pick://cancel?n=abc")), Some(None)));
    }
}
