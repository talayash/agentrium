//! AI Factory run state machine. Pure: no I/O, no clock. `apply` decides the next
//! status and what the caller should do; the IPC layer performs the side effects.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::error_reporter::user_err;
use crate::factory_def::{Definition, Step, Workspace, CHECK_OUTPUT_CHARS};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Queued,
    Running,
    Checking,
    WaitingGate,
    Blocked,
    Done,
    Cancelled,
}

impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            RunStatus::Queued => "queued",
            RunStatus::Running => "running",
            RunStatus::Checking => "checking",
            RunStatus::WaitingGate => "waiting_gate",
            RunStatus::Blocked => "blocked",
            RunStatus::Done => "done",
            RunStatus::Cancelled => "cancelled",
        }
    }

    /// Unknown strings map to `Cancelled` so a corrupt row never looks open.
    pub fn parse(s: &str) -> Self {
        match s {
            "queued" => RunStatus::Queued,
            "running" => RunStatus::Running,
            "checking" => RunStatus::Checking,
            "waiting_gate" => RunStatus::WaitingGate,
            "blocked" => RunStatus::Blocked,
            "done" => RunStatus::Done,
            _ => RunStatus::Cancelled,
        }
    }

    pub fn is_open(self) -> bool {
        !matches!(self, RunStatus::Done | RunStatus::Cancelled)
    }

    pub fn holds_line(self) -> bool {
        matches!(self, RunStatus::Running | RunStatus::Checking)
    }

    fn label(self) -> &'static str {
        match self {
            RunStatus::Queued => "queued",
            RunStatus::Running => "running",
            RunStatus::Checking => "checking",
            RunStatus::WaitingGate => "waiting at a gate",
            RunStatus::Blocked => "blocked",
            RunStatus::Done => "done",
            RunStatus::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FactoryRun {
    pub id: String,
    pub factory_id: String,
    pub input: String,
    pub status: RunStatus,
    pub current_step: String,
    pub attempts: BTreeMap<String, u32>,
    pub reject_reason: String,
    pub check_output: String,
    pub definition: Definition,
    pub workspace_path: String,
    pub branch: Option<String>,
    pub run_dir: String,
    pub terminal_id: Option<String>,
    /// When the current station attempt was opened (any way in except a
    /// Resume). An artifact older than this does not finish the station.
    pub station_started_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunEvent {
    Start,
    StationPassed,
    StationFailed { output: String },
    GateApproved { step_id: String },
    GateRejected { step_id: String, reason: String },
    Resume,
    AllowRetry,
    LineFreed,
    Cancel,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    StartStation { step_id: String, attempt: u32 },
    AwaitGate { step_id: String },
    Queued,
    Blocked,
    Finished,
    Cancelled,
}

pub(crate) fn wrong_state(run: &FactoryRun) -> String {
    user_err(format!(
        "This run is {}, so that action does not apply.",
        run.status.label()
    ))
}

/// Enter the step at `idx` (or finish when past the last step). Counts a station attempt.
fn enter(run: &mut FactoryRun, idx: usize, line_busy: bool) -> Action {
    match run.definition.steps.get(idx).cloned() {
        None => {
            run.status = RunStatus::Done;
            Action::Finished
        }
        Some(Step::Gate(g)) => {
            run.status = RunStatus::WaitingGate;
            run.current_step = g.id.clone();
            Action::AwaitGate { step_id: g.id }
        }
        Some(Step::Station(st)) => {
            run.current_step = st.id.clone();
            if run.definition.workspace == Workspace::InPlace && line_busy {
                run.status = RunStatus::Queued;
                return Action::Queued;
            }
            run.status = RunStatus::Running;
            let attempt = run.attempts.entry(st.id.clone()).or_insert(0);
            *attempt += 1;
            Action::StartStation {
                step_id: st.id,
                attempt: *attempt,
            }
        }
    }
}

fn current_index(run: &FactoryRun) -> Result<usize, String> {
    run.definition
        .index_of(&run.current_step)
        .ok_or_else(|| user_err("This run is no longer at a known step."))
}

fn current_cap(run: &FactoryRun) -> Result<u32, String> {
    run.definition
        .station(&run.current_step)
        .map(|s| s.cap())
        .ok_or_else(|| user_err("This run is not at a station."))
}

fn check_gate(run: &FactoryRun, step_id: &str) -> Result<(), String> {
    if run.status != RunStatus::WaitingGate {
        return Err(wrong_state(run));
    }
    if step_id != run.current_step {
        return Err(user_err("This run is no longer at that gate."));
    }
    Ok(())
}

fn last_chars(s: &str, n: usize) -> String {
    let count = s.chars().count();
    s.chars().skip(count.saturating_sub(n)).collect()
}

fn transition(run: &mut FactoryRun, event: RunEvent, line_busy: bool) -> Result<Action, String> {
    match event {
        RunEvent::Start => {
            if run.status != RunStatus::Queued || !run.attempts.is_empty() {
                return Err(wrong_state(run));
            }
            Ok(enter(run, 0, line_busy))
        }
        RunEvent::StationPassed => {
            if !run.status.holds_line() {
                return Err(wrong_state(run));
            }
            let next = current_index(run)? + 1;
            run.check_output.clear();
            run.reject_reason.clear();
            let next_is_station = matches!(run.definition.steps.get(next), Some(Step::Station(_)));
            Ok(enter(run, next, line_busy && !next_is_station))
        }
        RunEvent::StationFailed { output } => {
            if !run.status.holds_line() {
                return Err(wrong_state(run));
            }
            let cap = current_cap(run)?;
            run.check_output = last_chars(&output, CHECK_OUTPUT_CHARS);
            let used = run.attempts.get(&run.current_step).copied().unwrap_or(0);
            if used >= cap {
                run.status = RunStatus::Blocked;
                return Ok(Action::Blocked);
            }
            let idx = current_index(run)?;
            Ok(enter(run, idx, false))
        }
        RunEvent::GateApproved { step_id } => {
            check_gate(run, &step_id)?;
            let next = current_index(run)? + 1;
            Ok(enter(run, next, line_busy))
        }
        RunEvent::GateRejected { step_id, reason } => {
            check_gate(run, &step_id)?;
            let reason = reason.trim();
            if reason.is_empty() {
                return Err(user_err("Give a reason so the agent knows what to change."));
            }
            let target = match run.definition.gate(&step_id) {
                Some(g) => run
                    .definition
                    .index_of(&g.on_reject)
                    .ok_or_else(|| user_err("This gate's reject target no longer exists."))?,
                None => return Err(user_err("This run is no longer at that gate.")),
            };
            run.reject_reason = reason.to_string();
            let reset: Vec<String> = run.definition.steps[target..]
                .iter()
                .map(|s| s.id().to_string())
                .collect();
            for id in reset {
                run.attempts.remove(&id);
            }
            Ok(enter(run, target, line_busy))
        }
        RunEvent::Resume => {
            if !run.status.holds_line() {
                return Err(wrong_state(run));
            }
            current_cap(run)?;
            run.status = RunStatus::Running;
            Ok(Action::StartStation {
                step_id: run.current_step.clone(),
                attempt: run.attempts.get(&run.current_step).copied().unwrap_or(0),
            })
        }
        RunEvent::AllowRetry => {
            if run.status != RunStatus::Blocked {
                return Err(wrong_state(run));
            }
            let cap = current_cap(run)?;
            let idx = current_index(run)?;
            run.attempts
                .insert(run.current_step.clone(), cap.saturating_sub(1));
            Ok(enter(run, idx, line_busy))
        }
        RunEvent::LineFreed => {
            if run.status != RunStatus::Queued || run.current_step.is_empty() {
                return Err(wrong_state(run));
            }
            let idx = current_index(run)?;
            Ok(enter(run, idx, line_busy))
        }
        RunEvent::Cancel => {
            if !run.status.is_open() {
                return Err(wrong_state(run));
            }
            run.status = RunStatus::Cancelled;
            Ok(Action::Cancelled)
        }
    }
}

/// Apply `event` to `run`. `line_busy`: another run of the same factory is Running or
/// Checking. Computed on a clone, so an `Err` never leaves a half-changed run.
pub fn apply(run: &mut FactoryRun, event: RunEvent, line_busy: bool) -> Result<Action, String> {
    let mut next = run.clone();
    let action = transition(&mut next, event, line_busy)?;
    *run = next;
    Ok(action)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::factory_def::{parse_definition, Workspace, SAMPLE};

    fn run(def: Definition) -> FactoryRun {
        FactoryRun {
            id: "r1".to_string(),
            factory_id: "f1".to_string(),
            input: "A-1".to_string(),
            status: RunStatus::Queued,
            current_step: String::new(),
            attempts: Default::default(),
            reject_reason: String::new(),
            check_output: String::new(),
            definition: def,
            workspace_path: String::new(),
            branch: None,
            run_dir: String::new(),
            terminal_id: None,
            station_started_at: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn sample_run() -> FactoryRun {
        run(parse_definition(SAMPLE).unwrap())
    }

    fn start(id: &str, attempt: u32) -> Action {
        Action::StartStation {
            step_id: id.to_string(),
            attempt,
        }
    }

    fn started() -> FactoryRun {
        let mut r = sample_run();
        apply(&mut r, RunEvent::Start, false).unwrap();
        r
    }

    fn fail(r: &mut FactoryRun, out: &str) -> Result<Action, String> {
        apply(
            r,
            RunEvent::StationFailed {
                output: out.to_string(),
            },
            false,
        )
    }

    fn at_gate() -> FactoryRun {
        let mut r = started();
        apply(&mut r, RunEvent::StationPassed, false).unwrap();
        r
    }

    fn approve(r: &mut FactoryRun, busy: bool) -> Result<Action, String> {
        apply(
            r,
            RunEvent::GateApproved {
                step_id: "G1".to_string(),
            },
            busy,
        )
    }

    #[test]
    fn start_enters_first_station() {
        let mut r = sample_run();
        assert_eq!(
            apply(&mut r, RunEvent::Start, false).unwrap(),
            start("S1", 1)
        );
        assert_eq!(r.status, RunStatus::Running);
        assert_eq!(r.current_step, "S1");
    }

    #[test]
    fn start_queues_when_in_place_line_is_busy() {
        let mut r = sample_run();
        assert_eq!(
            apply(&mut r, RunEvent::Start, true).unwrap(),
            Action::Queued
        );
        assert_eq!(r.status, RunStatus::Queued);
        assert!(r.attempts.is_empty());
        assert_eq!(r.current_step, "S1");
    }

    #[test]
    fn worktree_runs_ignore_line_busy() {
        let mut r = sample_run();
        r.definition.workspace = Workspace::Worktree;
        assert_eq!(
            apply(&mut r, RunEvent::Start, true).unwrap(),
            start("S1", 1)
        );
    }

    #[test]
    fn line_freed_starts_the_queued_station() {
        let mut r = sample_run();
        apply(&mut r, RunEvent::Start, true).unwrap();
        assert_eq!(
            apply(&mut r, RunEvent::LineFreed, false).unwrap(),
            start("S1", 1)
        );
        assert_eq!(r.status, RunStatus::Running);
    }

    #[test]
    fn pass_moves_to_gate() {
        let mut r = started();
        r.check_output = "old".to_string();
        r.reject_reason = "old".to_string();
        assert_eq!(
            apply(&mut r, RunEvent::StationPassed, false).unwrap(),
            Action::AwaitGate {
                step_id: "G1".to_string()
            }
        );
        assert_eq!(r.status, RunStatus::WaitingGate);
        assert!(r.check_output.is_empty());
        assert!(r.reject_reason.is_empty());
    }

    #[test]
    fn fail_below_cap_retries_same_station_with_output() {
        let mut r = started();
        assert_eq!(fail(&mut r, "boom").unwrap(), start("S1", 2));
        assert_eq!(r.check_output, "boom");
    }

    #[test]
    fn fail_keeps_only_last_4000_chars() {
        let mut r = started();
        let out = format!("{}END", "x".repeat(5000));
        fail(&mut r, &out).unwrap();
        assert_eq!(r.check_output.chars().count(), 4000);
        assert!(r.check_output.ends_with("END"));
    }

    #[test]
    fn fail_keeps_multibyte_output_intact() {
        let mut r = started();
        let out = "\u{e9}".repeat(5000);
        fail(&mut r, &out).unwrap();
        assert_eq!(r.check_output.chars().count(), 4000);
    }

    #[test]
    fn fail_at_cap_blocks() {
        let mut r = started();
        assert_eq!(fail(&mut r, "1").unwrap(), start("S1", 2));
        assert_eq!(fail(&mut r, "2").unwrap(), start("S1", 3));
        assert_eq!(fail(&mut r, "3").unwrap(), Action::Blocked);
        assert_eq!(r.status, RunStatus::Blocked);
        assert_eq!(r.attempts["S1"], 3);
    }

    #[test]
    fn allow_retry_gives_exactly_one_more() {
        let mut r = started();
        fail(&mut r, "1").unwrap();
        fail(&mut r, "2").unwrap();
        fail(&mut r, "3").unwrap();
        assert_eq!(
            apply(&mut r, RunEvent::AllowRetry, false).unwrap(),
            start("S1", 3)
        );
        assert_eq!(fail(&mut r, "4").unwrap(), Action::Blocked);
    }

    #[test]
    fn approve_enters_next_station() {
        let mut r = at_gate();
        assert_eq!(approve(&mut r, false).unwrap(), start("S2", 1));
        assert_eq!(r.status, RunStatus::Running);
    }

    #[test]
    fn approve_queues_when_line_is_busy() {
        let mut r = at_gate();
        assert_eq!(approve(&mut r, true).unwrap(), Action::Queued);
        assert_eq!(r.status, RunStatus::Queued);
        assert_eq!(r.current_step, "S2");
    }

    #[test]
    fn reject_needs_a_reason() {
        let mut r = at_gate();
        let err = apply(
            &mut r,
            RunEvent::GateRejected {
                step_id: "G1".to_string(),
                reason: "  ".to_string(),
            },
            false,
        )
        .unwrap_err();
        assert!(err.contains("Give a reason"), "{err}");
        assert_eq!(r.status, RunStatus::WaitingGate);
    }

    #[test]
    fn reject_goes_back_and_resets_attempts() {
        let mut r = started();
        fail(&mut r, "x").unwrap();
        apply(&mut r, RunEvent::StationPassed, false).unwrap();
        assert_eq!(
            apply(
                &mut r,
                RunEvent::GateRejected {
                    step_id: "G1".to_string(),
                    reason: " fix AC2 ".to_string(),
                },
                false,
            )
            .unwrap(),
            start("S1", 1)
        );
        assert_eq!(r.reject_reason, "fix AC2");
    }

    #[test]
    fn gate_answer_for_another_gate_is_refused() {
        let mut r = at_gate();
        let err = apply(
            &mut r,
            RunEvent::GateApproved {
                step_id: "G9".to_string(),
            },
            false,
        )
        .unwrap_err();
        assert!(err.contains("no longer at that gate"), "{err}");
    }

    #[test]
    fn last_station_pass_finishes() {
        let mut r = at_gate();
        approve(&mut r, false).unwrap();
        assert_eq!(
            apply(&mut r, RunEvent::StationPassed, false).unwrap(),
            Action::Finished
        );
        assert_eq!(r.status, RunStatus::Done);
    }

    #[test]
    fn resume_from_checking_restarts_the_station_without_counting() {
        let mut r = started();
        fail(&mut r, "x").unwrap();
        r.status = RunStatus::Checking;
        assert_eq!(
            apply(&mut r, RunEvent::Resume, false).unwrap(),
            start("S1", 2)
        );
        assert_eq!(r.status, RunStatus::Running);
        assert_eq!(r.attempts["S1"], 2);
    }

    #[test]
    fn cancel_from_any_open_status() {
        for status in [
            RunStatus::Queued,
            RunStatus::Running,
            RunStatus::Checking,
            RunStatus::WaitingGate,
            RunStatus::Blocked,
        ] {
            let mut r = started();
            r.status = status;
            assert_eq!(
                apply(&mut r, RunEvent::Cancel, false).unwrap(),
                Action::Cancelled
            );
            assert_eq!(r.status, RunStatus::Cancelled);
        }
    }

    #[test]
    fn cancel_on_done_is_refused() {
        let mut r = started();
        r.status = RunStatus::Done;
        let err = apply(&mut r, RunEvent::Cancel, false).unwrap_err();
        assert!(err.contains("This run is done"), "{err}");
    }

    #[test]
    fn wrong_state_event_changes_nothing() {
        let mut r = at_gate();
        let before = r.clone();
        assert!(apply(&mut r, RunEvent::StationPassed, false).is_err());
        assert_eq!(r, before);
    }

    #[test]
    fn status_strings_round_trip() {
        for s in [
            RunStatus::Queued,
            RunStatus::Running,
            RunStatus::Checking,
            RunStatus::WaitingGate,
            RunStatus::Blocked,
            RunStatus::Done,
            RunStatus::Cancelled,
        ] {
            assert_eq!(RunStatus::parse(s.as_str()), s);
        }
        assert_eq!(RunStatus::parse("bogus"), RunStatus::Cancelled);
        assert!(RunStatus::Blocked.is_open());
        assert!(!RunStatus::Done.is_open());
        assert!(RunStatus::Checking.holds_line());
        assert!(!RunStatus::WaitingGate.holds_line());
    }
}
