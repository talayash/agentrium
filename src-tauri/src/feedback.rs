//! Pure validation for the "Contact us" feedback form.
//!
//! Rules mirror `src/lib/feedbackForm.ts` so the frontend and backend agree on
//! what a valid submission looks like. The frontend enforces these for UX; the
//! Rust side re-enforces them because a compromised WebView cannot be trusted.

use serde::{Deserialize, Serialize};

pub const NAME_MAX: usize = 60;
pub const MESSAGE_MAX: usize = 2000;

/// Destination URL for the feedback endpoint, injected at build time.
/// `None` at runtime means dev builds and unofficial installs: the command
/// validates and then no-ops so the UI still works for local testing.
pub const FEEDBACK_URL: Option<&str> = option_env!("AGENTRIUM_FEEDBACK_URL");

/// Wire format sent to the feedback endpoint. Kept minimal on purpose:
/// no email, no installation id, no client-side ip - so this endpoint stays
/// uninteresting to scrapers and low-value if leaked.
#[derive(Debug, Serialize)]
pub struct FeedbackPayload<'a> {
    pub name: &'a str,
    pub message: &'a str,
    pub app_version: &'a str,
    pub os: &'static str,
}

impl<'a> FeedbackPayload<'a> {
    pub fn from_valid(v: &'a ValidFeedback, app_version: &'a str) -> Self {
        Self {
            name: &v.name,
            message: &v.message,
            app_version,
            os: std::env::consts::OS,
        }
    }
}

/// Raw payload from the frontend. `honeypot` is a hidden form field: real users
/// leave it empty, bots fill every input they see.
#[derive(Debug, Deserialize)]
pub struct FeedbackInput {
    pub name: String,
    pub message: String,
    pub honeypot: String,
}

/// A validated feedback submission, ready to forward to the backend endpoint.
#[derive(Debug, PartialEq, Eq)]
pub struct ValidFeedback {
    pub name: String,
    pub message: String,
}

/// Validate a feedback submission. Returns the trimmed, ready-to-send value on
/// success. On failure returns a user-facing message; the caller should wrap
/// the error with `error_reporter::user_err` before returning from a command so
/// it isn't reported as an internal bug.
pub fn validate(input: FeedbackInput) -> Result<ValidFeedback, String> {
    if !input.honeypot.is_empty() {
        return Err("Spam detected".to_string());
    }
    let name = input.name.trim();
    if name.is_empty() {
        return Err("Name is required".to_string());
    }
    if name.chars().count() > NAME_MAX {
        return Err(format!("Name must be {} characters or fewer", NAME_MAX));
    }
    let message = input.message.trim();
    if message.is_empty() {
        return Err("Message is required".to_string());
    }
    if message.chars().count() > MESSAGE_MAX {
        return Err(format!("Message must be {} characters or fewer", MESSAGE_MAX));
    }
    Ok(ValidFeedback {
        name: name.to_string(),
        message: message.to_string(),
    })
}

/// Path of the local dev-mode inbox: `<data_dir>/feedback-inbox.jsonl`.
/// Returns `None` on the (unusual) systems where a data dir cannot be resolved.
pub fn inbox_path() -> Option<std::path::PathBuf> {
    directories::ProjectDirs::from("com", "claudeterminal", "ClaudeTerminal")
        .map(|d| d.data_dir().join("feedback-inbox.jsonl"))
}

/// Append one validated submission as a JSON line. Kept plain (name, message,
/// timestamp) so a developer can `cat` the file during QA. Creates parent
/// directories if missing.
pub fn append_to_inbox(path: &std::path::Path, v: &ValidFeedback) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let entry = serde_json::json!({
        "ts": chrono::Utc::now().to_rfc3339(),
        "name": v.name,
        "message": v.message,
    });
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(file, "{}", entry)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok_input() -> FeedbackInput {
        FeedbackInput {
            name: "Tal".into(),
            message: "Hi there".into(),
            honeypot: String::new(),
        }
    }

    #[test]
    fn accepts_normal_name_and_message() {
        let v = validate(ok_input()).unwrap();
        assert_eq!(v.name, "Tal");
        assert_eq!(v.message, "Hi there");
    }

    #[test]
    fn trims_whitespace_from_name_and_message() {
        let v = validate(FeedbackInput {
            name: "  Tal  ".into(),
            message: "\n Hi \t".into(),
            honeypot: String::new(),
        })
        .unwrap();
        assert_eq!(v.name, "Tal");
        assert_eq!(v.message, "Hi");
    }

    #[test]
    fn rejects_filled_honeypot_as_spam_even_when_other_fields_valid() {
        let err = validate(FeedbackInput {
            honeypot: "http://spam.example".into(),
            ..ok_input()
        })
        .unwrap_err();
        assert_eq!(err, "Spam detected");
    }

    #[test]
    fn rejects_empty_name() {
        let err = validate(FeedbackInput { name: String::new(), ..ok_input() }).unwrap_err();
        assert_eq!(err, "Name is required");
    }

    #[test]
    fn rejects_whitespace_only_name() {
        let err = validate(FeedbackInput { name: "   ".into(), ..ok_input() }).unwrap_err();
        assert_eq!(err, "Name is required");
    }

    #[test]
    fn rejects_name_over_max_length() {
        let err = validate(FeedbackInput {
            name: "x".repeat(NAME_MAX + 1),
            ..ok_input()
        })
        .unwrap_err();
        assert_eq!(err, format!("Name must be {} characters or fewer", NAME_MAX));
    }

    #[test]
    fn accepts_name_of_exactly_max_length() {
        let v = validate(FeedbackInput {
            name: "x".repeat(NAME_MAX),
            ..ok_input()
        })
        .unwrap();
        assert_eq!(v.name.chars().count(), NAME_MAX);
    }

    #[test]
    fn rejects_empty_message() {
        let err = validate(FeedbackInput { message: String::new(), ..ok_input() }).unwrap_err();
        assert_eq!(err, "Message is required");
    }

    #[test]
    fn rejects_whitespace_only_message() {
        let err = validate(FeedbackInput {
            message: "   \n\t".into(),
            ..ok_input()
        })
        .unwrap_err();
        assert_eq!(err, "Message is required");
    }

    #[test]
    fn rejects_message_over_max_length() {
        let err = validate(FeedbackInput {
            message: "x".repeat(MESSAGE_MAX + 1),
            ..ok_input()
        })
        .unwrap_err();
        assert_eq!(err, format!("Message must be {} characters or fewer", MESSAGE_MAX));
    }

    #[test]
    fn honeypot_short_circuits_before_field_validation() {
        // Bot filled the honeypot but left name/message blank: caller must not
        // learn which field to fix - the response is the generic spam message.
        let err = validate(FeedbackInput {
            name: String::new(),
            message: String::new(),
            honeypot: "bot".into(),
        })
        .unwrap_err();
        assert_eq!(err, "Spam detected");
    }

    #[test]
    fn payload_from_valid_serializes_all_wire_fields() {
        let v = ValidFeedback { name: "Tal".into(), message: "Hi".into() };
        let p = FeedbackPayload::from_valid(&v, "1.33.4");
        let json = serde_json::to_value(&p).unwrap();
        assert_eq!(json["name"], "Tal");
        assert_eq!(json["message"], "Hi");
        assert_eq!(json["app_version"], "1.33.4");
        assert!(json.get("os").is_some(), "os field must be present");
        // Belt-and-braces: catch accidental future additions that leak PII.
        let obj = json.as_object().unwrap();
        let keys: Vec<&str> = obj.keys().map(|k| k.as_str()).collect();
        assert_eq!(keys.len(), 4, "unexpected fields in payload: {:?}", keys);
    }

    #[test]
    fn append_to_inbox_writes_one_json_line_per_entry_and_appends() {
        let dir = std::env::temp_dir()
            .join(format!("agentrium-feedback-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("inbox.jsonl");

        append_to_inbox(&path, &ValidFeedback { name: "A".into(), message: "one".into() }).unwrap();
        append_to_inbox(&path, &ValidFeedback { name: "B".into(), message: "two".into() }).unwrap();

        let contents = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(lines.len(), 2, "expected exactly two lines, got {:?}", lines);

        let first: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(first["name"], "A");
        assert_eq!(first["message"], "one");
        assert!(first["ts"].is_string(), "ts must be a string, got {:?}", first["ts"]);

        let second: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(second["name"], "B");
        assert_eq!(second["message"], "two");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn char_count_boundary_uses_scalars_not_bytes() {
        // Regression guard: a multi-byte character (e.g. an emoji or accented
        // letter) must count as one character. Using `.len()` here would treat
        // a 60-emoji name as ~240 bytes and wrongly reject it.
        let sixty_emoji = "😀".repeat(NAME_MAX);
        let v = validate(FeedbackInput { name: sixty_emoji, ..ok_input() }).unwrap();
        assert_eq!(v.name.chars().count(), NAME_MAX);
    }
}
