//! AI Factory definition file format: types, parsing, lint and prompt rendering.
//! Pure functions only, no I/O. Everything here is the on-disk wire format (snake_case).
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

use crate::config::AgentKind;
use crate::error_reporter::strip_user_prefix;
use crate::races::validate_check_command;

pub const DEFINITION_VERSION: u32 = 1;
pub const DEFAULT_LOOP_CAP: u32 = 3;
pub const DEFAULT_CHECK_TIMEOUT_SECS: u64 = 300;
pub const MAX_CHECK_TIMEOUT_SECS: u64 = 3600;
pub const CHECK_OUTPUT_CHARS: usize = 4000;

const MIN_CHECK_TIMEOUT_SECS: u64 = 5;
const MAX_STEP_ID_LEN: usize = 16;
const MAX_INPUT_LEN: usize = 200;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Definition {
    pub version: u32,
    pub name: String,
    pub source: String,
    #[serde(default)]
    pub source_sha256: String,
    pub input: InputSpec,
    #[serde(default)]
    pub workspace: Workspace,
    #[serde(default)]
    pub agent: AgentKind,
    #[serde(default)]
    pub rules: Vec<String>,
    pub steps: Vec<Step>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InputSpec {
    pub label: String,
    #[serde(default)]
    pub placeholder: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Workspace {
    #[default]
    Worktree,
    InPlace,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Step {
    Station(Station),
    Gate(Gate),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Station {
    pub id: String,
    pub name: String,
    pub prompt: String,
    #[serde(default)]
    pub artifact: Option<String>,
    #[serde(default)]
    pub check: Option<Check>,
    #[serde(default)]
    pub loop_cap: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Check {
    pub command: String,
    #[serde(default)]
    pub timeout_sec: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Gate {
    pub id: String,
    pub name: String,
    pub question: String,
    pub pass_label: String,
    pub reject_label: String,
    #[serde(default)]
    pub show: Vec<String>,
    #[serde(default)]
    pub notes: Vec<String>,
    pub on_reject: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
pub struct Lint {
    pub errors: Vec<LintItem>,
    pub warnings: Vec<LintItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LintItem {
    pub step_id: Option<String>,
    pub message: String,
}

impl Step {
    pub fn id(&self) -> &str {
        match self {
            Step::Station(s) => &s.id,
            Step::Gate(g) => &g.id,
        }
    }

    pub fn name(&self) -> &str {
        match self {
            Step::Station(s) => &s.name,
            Step::Gate(g) => &g.name,
        }
    }
}

impl Station {
    /// Loop cap with the default applied.
    pub fn cap(&self) -> u32 {
        self.loop_cap.unwrap_or(DEFAULT_LOOP_CAP)
    }

    /// Check timeout with the default applied, clamped to 5..=3600 seconds.
    pub fn timeout_secs(&self) -> u64 {
        self.check
            .as_ref()
            .and_then(|c| c.timeout_sec)
            .unwrap_or(DEFAULT_CHECK_TIMEOUT_SECS)
            .clamp(MIN_CHECK_TIMEOUT_SECS, MAX_CHECK_TIMEOUT_SECS)
    }
}

impl Definition {
    pub fn index_of(&self, step_id: &str) -> Option<usize> {
        self.steps.iter().position(|s| s.id() == step_id)
    }

    pub fn station(&self, step_id: &str) -> Option<&Station> {
        self.steps.iter().find_map(|s| match s {
            Step::Station(st) if st.id == step_id => Some(st),
            _ => None,
        })
    }

    pub fn gate(&self, step_id: &str) -> Option<&Gate> {
        self.steps.iter().find_map(|s| match s {
            Step::Gate(g) if g.id == step_id => Some(g),
            _ => None,
        })
    }

    /// True when any station's check command uses the `{input}` placeholder.
    pub fn uses_input_in_check(&self) -> bool {
        self.steps.iter().any(|s| match s {
            Step::Station(st) => st
                .check
                .as_ref()
                .is_some_and(|c| c.command.contains("{input}")),
            Step::Gate(_) => false,
        })
    }
}

pub fn parse_definition(json: &str) -> Result<Definition, String> {
    serde_json::from_str(json).map_err(|e| format!("Not a valid factory definition: {e}"))
}

fn valid_step_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_STEP_ID_LEN
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn error(step_id: Option<&str>, message: String) -> LintItem {
    LintItem {
        step_id: step_id.map(str::to_string),
        message,
    }
}

pub fn validate(def: &Definition) -> Lint {
    let mut lint = Lint::default();

    if def.version != DEFINITION_VERSION {
        lint.errors.push(error(
            None,
            format!(
                "Unsupported definition version {}. This Agentrium supports version {}.",
                def.version, DEFINITION_VERSION
            ),
        ));
    }
    if def.steps.is_empty() {
        lint.errors.push(error(
            None,
            "A factory needs at least one step.".to_string(),
        ));
    }
    if matches!(def.steps.first(), Some(Step::Gate(_))) {
        lint.errors
            .push(error(None, "The first step must be a station.".to_string()));
    }

    let mut seen: Vec<&str> = Vec::new();
    for (idx, step) in def.steps.iter().enumerate() {
        let id = step.id();
        if seen.contains(&id) {
            lint.errors.push(error(
                Some(id),
                format!("Step id {id} is used more than once."),
            ));
        } else {
            seen.push(id);
        }
        if !valid_step_id(id) {
            lint.errors.push(error(
                Some(id),
                format!("Step id \"{id}\" must be 1 to 16 letters, digits, - or _."),
            ));
        }

        match step {
            Step::Station(st) => {
                if st.prompt.trim().is_empty() {
                    lint.errors
                        .push(error(Some(id), format!("Station {id} has no prompt.")));
                }
                if let Some(artifact) = &st.artifact {
                    if !is_plain_file_name(artifact) {
                        lint.errors.push(error(
                            Some(id),
                            format!("{id}: \"{artifact}\" must be a plain file name."),
                        ));
                    }
                }
                if let Some(check) = &st.check {
                    if let Err(e) = validate_check_command(&check.command) {
                        lint.errors.push(error(
                            Some(id),
                            format!("{id} check command: {}", strip_user_prefix(&e)),
                        ));
                    }
                }
                if st.check.is_none() && st.artifact.is_none() {
                    lint.warnings.push(error(
                        Some(id),
                        "Finishes only when you mark it done.".to_string(),
                    ));
                }
            }
            Step::Gate(g) => {
                if g.question.trim().is_empty()
                    || g.pass_label.trim().is_empty()
                    || g.reject_label.trim().is_empty()
                {
                    lint.errors.push(error(
                        Some(id),
                        format!("Gate {id} needs a question and both button labels."),
                    ));
                }
                // A gate in first position already has its own error; skip the
                // reject target check so that mistake is reported once.
                if idx > 0 {
                    let earlier_station = def.steps[..idx]
                        .iter()
                        .any(|s| matches!(s, Step::Station(st) if st.id == g.on_reject));
                    if !earlier_station {
                        lint.errors.push(error(
                            Some(id),
                            format!(
                                "Gate {id} sends rejects to {}, which is not an earlier station.",
                                g.on_reject
                            ),
                        ));
                    }
                }
                for name in &g.show {
                    if !is_plain_file_name(name) {
                        lint.errors.push(error(
                            Some(id),
                            format!("{id}: \"{name}\" must be a plain file name."),
                        ));
                    }
                }
                if idx > 0 && matches!(def.steps[idx - 1], Step::Gate(_)) {
                    lint.warnings
                        .push(error(Some(id), "Two gates in a row.".to_string()));
                }
            }
        }
    }

    if !def.rules.is_empty() {
        lint.warnings.push(error(
            None,
            "Rules are given to the agent as instructions. Agentrium does not enforce them."
                .to_string(),
        ));
    }
    if !def.steps.is_empty() && !def.steps.iter().any(|s| matches!(s, Step::Gate(_))) {
        lint.warnings.push(error(
            None,
            "No human gate: this line runs unattended to the end.".to_string(),
        ));
    }

    lint
}

/// Safe input: `^[A-Za-z0-9._:/#@-]{1,200}$`.
pub fn input_is_safe(input: &str) -> bool {
    !input.is_empty()
        && input.len() <= MAX_INPUT_LEN
        && input
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._:/#@-".contains(c))
}

pub fn is_plain_file_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains(':')
        && name != "."
        && name != ".."
}

pub struct PromptVars<'a> {
    pub input: &'a str,
    pub run_dir: &'a str,
    pub reject_reason: &'a str,
    pub check_output: &'a str,
}

pub fn render_prompt(def: &Definition, station: &Station, vars: &PromptVars) -> String {
    let mut out = station
        .prompt
        .replace("{input}", vars.input)
        .replace("{run_dir}", vars.run_dir)
        .replace("{reject_reason}", vars.reject_reason)
        .replace("{check_output}", vars.check_output);
    if !def.rules.is_empty() {
        out.push_str("\n\nRules for this run:");
        for rule in &def.rules {
            out.push_str("\n- ");
            out.push_str(rule);
        }
    }
    out
}

/// The station's check command with `{input}` and `{run_dir}` substituted raw.
pub fn render_check_command(station: &Station, input: &str, run_dir: &str) -> Option<String> {
    station.check.as_ref().map(|c| {
        c.command
            .replace("{input}", input)
            .replace("{run_dir}", run_dir)
    })
}

#[cfg(test)]
pub(crate) const SAMPLE: &str = r#"{"version":1,"name":"demo","source":"SKILL.md","input":{"label":"Ticket"},
 "workspace":"in_place","rules":["Never merge a pull request."],
 "steps":[
  {"kind":"station","id":"S1","name":"Plan","prompt":"Plan {input} into {run_dir}. {reject_reason}{check_output}","artifact":"plan.md","check":{"command":"node check.js {input}"}},
  {"kind":"gate","id":"G1","name":"Plan approval","question":"Approve this plan?","pass_label":"Approve","reject_label":"Reject","show":["plan.md"],"on_reject":"S1"},
  {"kind":"station","id":"S2","name":"Build","prompt":"Build it."}
 ]}"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Definition {
        parse_definition(SAMPLE).unwrap()
    }

    fn only_error(def: &Definition) -> String {
        let lint = validate(def);
        assert_eq!(lint.errors.len(), 1, "errors: {:?}", lint.errors);
        lint.errors[0].message.clone()
    }

    fn station_mut(def: &mut Definition, idx: usize) -> &mut Station {
        match &mut def.steps[idx] {
            Step::Station(s) => s,
            Step::Gate(_) => panic!("not a station"),
        }
    }

    fn gate_mut(def: &mut Definition, idx: usize) -> &mut Gate {
        match &mut def.steps[idx] {
            Step::Gate(g) => g,
            Step::Station(_) => panic!("not a gate"),
        }
    }

    #[test]
    fn parses_sample_with_defaults() {
        let def = sample();
        assert_eq!(def.workspace, Workspace::InPlace);
        assert_eq!(def.agent, AgentKind::default());
        assert_eq!(def.steps.len(), 3);
        let s1 = def.station("S1").unwrap();
        assert_eq!(s1.cap(), 3);
        assert_eq!(s1.timeout_secs(), 300);
    }

    #[test]
    fn parse_rejects_unknown_workspace() {
        let err = parse_definition(&SAMPLE.replace("in_place", "shared")).unwrap_err();
        assert!(err.starts_with("Not a valid factory definition: "), "{err}");
    }

    #[test]
    fn timeout_is_clamped() {
        let mut def = sample();
        station_mut(&mut def, 0).check.as_mut().unwrap().timeout_sec = Some(1);
        assert_eq!(def.station("S1").unwrap().timeout_secs(), 5);
        station_mut(&mut def, 0).check.as_mut().unwrap().timeout_sec = Some(99_999);
        assert_eq!(def.station("S1").unwrap().timeout_secs(), 3600);
    }

    #[test]
    fn helpers_find_steps() {
        let def = sample();
        assert_eq!(def.index_of("G1"), Some(1));
        assert_eq!(def.index_of("nope"), None);
        assert!(def.gate("G1").is_some());
        assert!(def.gate("S1").is_none());
        assert!(def.uses_input_in_check());
        assert_eq!(def.steps[1].name(), "Plan approval");
    }

    #[test]
    fn sample_has_no_errors() {
        assert!(validate(&sample()).errors.is_empty());
    }

    #[test]
    fn lint_unsupported_version() {
        let mut def = sample();
        def.version = 2;
        assert_eq!(
            only_error(&def),
            "Unsupported definition version 2. This Agentrium supports version 1."
        );
    }

    #[test]
    fn lint_empty_steps() {
        let mut def = sample();
        def.steps.clear();
        assert_eq!(only_error(&def), "A factory needs at least one step.");
    }

    #[test]
    fn lint_first_step_gate() {
        let mut def = sample();
        def.steps.remove(0);
        def.steps.pop();
        assert_eq!(only_error(&def), "The first step must be a station.");
    }

    #[test]
    fn lint_duplicate_id() {
        let mut def = sample();
        station_mut(&mut def, 2).id = "S1".to_string();
        assert_eq!(only_error(&def), "Step id S1 is used more than once.");
    }

    #[test]
    fn lint_bad_id() {
        let mut def = sample();
        station_mut(&mut def, 2).id = "bad id".to_string();
        assert_eq!(
            only_error(&def),
            "Step id \"bad id\" must be 1 to 16 letters, digits, - or _."
        );
    }

    #[test]
    fn lint_reject_target_missing_or_later() {
        let mut def = sample();
        gate_mut(&mut def, 1).on_reject = "S9".to_string();
        assert_eq!(
            only_error(&def),
            "Gate G1 sends rejects to S9, which is not an earlier station."
        );
        gate_mut(&mut def, 1).on_reject = "S2".to_string();
        assert_eq!(
            only_error(&def),
            "Gate G1 sends rejects to S2, which is not an earlier station."
        );
    }

    #[test]
    fn lint_empty_prompt() {
        let mut def = sample();
        station_mut(&mut def, 0).prompt = String::new();
        assert_eq!(only_error(&def), "Station S1 has no prompt.");
    }

    #[test]
    fn lint_gate_needs_question_and_labels() {
        for field in 0..3 {
            let mut def = sample();
            let g = gate_mut(&mut def, 1);
            match field {
                0 => g.question = String::new(),
                1 => g.pass_label = String::new(),
                _ => g.reject_label = String::new(),
            }
            assert_eq!(
                only_error(&def),
                "Gate G1 needs a question and both button labels."
            );
        }
    }

    #[test]
    fn lint_artifact_and_show_must_be_plain_names() {
        let mut def = sample();
        station_mut(&mut def, 0).artifact = Some("../x.md".to_string());
        assert_eq!(
            only_error(&def),
            "S1: \"../x.md\" must be a plain file name."
        );

        let mut def = sample();
        gate_mut(&mut def, 1).show = vec!["../x.md".to_string()];
        assert_eq!(
            only_error(&def),
            "G1: \"../x.md\" must be a plain file name."
        );
    }

    #[test]
    fn lint_refused_check_command() {
        let mut def = sample();
        station_mut(&mut def, 0).check.as_mut().unwrap().command = "a\nb".to_string();
        let refused = validate_check_command("a\nb").unwrap_err();
        assert_eq!(
            only_error(&def),
            format!("S1 check command: {}", strip_user_prefix(&refused))
        );
    }

    #[test]
    fn lint_warnings() {
        let lint = validate(&sample());
        assert!(lint.warnings.contains(&LintItem {
            step_id: Some("S2".to_string()),
            message: "Finishes only when you mark it done.".to_string(),
        }));
        assert!(lint.warnings.contains(&LintItem {
            step_id: None,
            message:
                "Rules are given to the agent as instructions. Agentrium does not enforce them."
                    .to_string(),
        }));

        let mut def = sample();
        let mut second = gate_mut(&mut def, 1).clone();
        second.id = "G2".to_string();
        def.steps.insert(2, Step::Gate(second));
        let lint = validate(&def);
        assert!(lint.errors.is_empty(), "{:?}", lint.errors);
        assert!(lint.warnings.contains(&LintItem {
            step_id: Some("G2".to_string()),
            message: "Two gates in a row.".to_string(),
        }));

        let mut def = sample();
        def.steps.remove(1);
        assert!(validate(&def).warnings.contains(&LintItem {
            step_id: None,
            message: "No human gate: this line runs unattended to the end.".to_string(),
        }));
    }

    #[test]
    fn input_safety() {
        for ok in [
            "WGCP-12345",
            "https://x.atlassian.net/browse/A-1",
            "feat/a_b#3",
        ] {
            assert!(input_is_safe(ok), "{ok}");
        }
        let long = "a".repeat(201);
        for bad in ["", "a b", "a;rm", "$(x)", "a\"b", long.as_str()] {
            assert!(!input_is_safe(bad), "{bad}");
        }
    }

    #[test]
    fn plain_file_names() {
        assert!(is_plain_file_name("plan.md"));
        for bad in ["", "a/b", "a\\b", ".", "..", "C:x"] {
            assert!(!is_plain_file_name(bad), "{bad}");
        }
    }

    #[test]
    fn render_prompt_substitutes_and_appends_rules() {
        let def = sample();
        let vars = PromptVars {
            input: "A-1",
            run_dir: "C:\\runs\\r1",
            reject_reason: "fix AC2",
            check_output: "",
        };
        assert_eq!(
            render_prompt(&def, def.station("S1").unwrap(), &vars),
            "Plan A-1 into C:\\runs\\r1. fix AC2\n\nRules for this run:\n- Never merge a pull request."
        );
    }

    #[test]
    fn render_prompt_without_rules_adds_nothing() {
        let mut def = sample();
        def.rules.clear();
        let vars = PromptVars {
            input: "A-1",
            run_dir: "d",
            reject_reason: "",
            check_output: "",
        };
        assert_eq!(
            render_prompt(&def, def.station("S2").unwrap(), &vars),
            "Build it."
        );
    }

    #[test]
    fn render_check_command_substitutes() {
        let mut def = sample();
        assert_eq!(
            render_check_command(def.station("S1").unwrap(), "A-1", "C:\\r"),
            Some("node check.js A-1".to_string())
        );
        assert_eq!(
            render_check_command(def.station("S2").unwrap(), "A-1", "C:\\r"),
            None
        );
        station_mut(&mut def, 0).check.as_mut().unwrap().command = "t {run_dir}".to_string();
        assert_eq!(
            render_check_command(def.station("S1").unwrap(), "A-1", "C:\\r"),
            Some("t C:\\r".to_string())
        );
    }
}
