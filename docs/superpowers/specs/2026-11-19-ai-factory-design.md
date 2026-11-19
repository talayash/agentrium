# AI Factory - design

Date: 2026-11-19. Status: draft, written from the brainstorm. Items marked **(call)** were
decided by Claude and not yet confirmed by Tal.

## Intent

Let any Agentrium user turn their own repeatable agent process into a watchable production
line. The user keeps describing the process in a Markdown file in their repo (for example
the existing `webguru-flow` skill). Agentrium reads it, runs it station by station, stops at
every human gate, and shows all runs on one screen. Every company has different goals, so
nothing about Jira, Bitbucket, deploys or any other tool is built into Agentrium.

## Goals

- Add a factory by picking a repo and a Markdown file. No builder to learn.
- Start a run in about 10 seconds by giving the one input the factory declares.
- Stations run unattended; a gate can only be passed by a human in the Agentrium UI.
- One screen shows every run, where it is, and what is waiting for the user.
- Runs survive an app restart.
- A team shares a factory by committing two files to git.

## Non-goals (this version)

- No visual pipeline builder.
- No built-in integrations (issue trackers, git hosts, CI, deploy).
- No cloud execution and no sync: factories and runs are local only, like races.
- No "Improve" screen (run statistics, agent-proposed edits). Separate plan.
- No detected (polled) gates, no gate effects, no tool-call guard hooks. Separate plan.
  In this version a detected gate is modelled as an asked gate ("Has it merged?").

## Anti-goals

- An agent must never be able to pass a gate or edit run state.
- A command that came from a repo file must never run before the user has seen and
  confirmed it on this machine.
- Agentrium must never type a prompt into a PTY (existing rule).
- The Sessions tab must look exactly as today for a user with no factories.

## Approaches considered

- **A. Import and confirm (chosen by Tal).** Any Markdown file; an agent reads it once and
  produces a structured definition; the user checks it; it is saved next to the file as
  `<stem>.factory.json`. Works for existing files and for non-developers. Cost: the import
  can misread, so a confirm screen is required, and two files must stay in step.
- **B. Strict Markdown template parsed without AI.** Predictable and one file, but every
  author must learn the format and existing skills need a rewrite.
- **C. Agent drives, Agentrium only watches a state file.** Least to build, but the agent
  holds the state, so gates are only as strong as the prompt.

## Vocabulary

- **Factory**: a definition (ordered steps) tied to a repo and a source Markdown file.
- **Step**: a **station** or a **gate**, in one ordered list.
- **Station**: a prompt given to an agent session, an optional artifact file it must
  produce, an optional check command whose exit code 0 means "station done", a loop cap.
- **Gate**: a question to the human with a pass label and a reject label. Reject needs a
  reason and sends the run back to a named station.
- **Run**: one input going down the line. Has a run directory for its artifacts.

## Definition file

`<stem>.factory.json`, next to the source Markdown (for `SKILL.md` it is
`SKILL.factory.json`). **(call)**

```json
{
  "version": 1,
  "name": "webguru-flow",
  "source": "SKILL.md",
  "source_sha256": "<hex of the Markdown at import time>",
  "input": { "label": "Ticket key or URL", "placeholder": "WGCP-12345" },
  "workspace": "in_place",
  "agent": "claude",
  "rules": ["Never push to master-israir.", "Never merge a pull request."],
  "steps": [
    { "kind": "station", "id": "S2", "name": "Plan",
      "prompt": "Write plan.md into {run_dir} for {input} ...",
      "artifact": "plan.md",
      "check": { "command": "node .claude/helpers/flow-state.cjs plan-check {input}", "timeout_sec": 300 },
      "loop_cap": 3 },
    { "kind": "gate", "id": "G1", "name": "Plan approval",
      "question": "Approve this plan?",
      "pass_label": "Approve", "reject_label": "Reject",
      "show": ["plan.md"],
      "notes": ["Approving allows the commit, the feature-branch push and the PR."],
      "on_reject": "S2" }
  ]
}
```

Rules:

- `id` is unique across steps, 1 to 16 chars, `[A-Za-z0-9_-]`.
- `workspace` is `worktree` (one task worktree per run, the default) or `in_place` (runs
  work in the repo root). **(call)**
- `agent` is an `AgentKind` wire value. Only agents with an initial-prompt capability can
  run stations in this version. **(call)**
- `rules` are plain sentences appended to every station prompt. They are prompt-level only
  in this version; the UI says so.
- `loop_cap` defaults to 3. `check.timeout_sec` defaults to 300, maximum 3600.
- `artifact` and every `show` entry are file names relative to the run directory, no path
  separators, no `..`.
- Placeholders in `prompt` and `check.command`: `{input}`, `{run_dir}`. In `prompt` only:
  `{reject_reason}` (empty unless the station was re-entered from a rejected gate) and
  `{check_output}` (empty unless this is a retry after a failed check).
- `{input}` is substituted into `check.command` only if the input matches
  `^[A-Za-z0-9._:/#@-]{1,200}$`; otherwise starting the run is refused with a user error.
  The check also receives `AGENTRIUM_RUN_DIR` and `AGENTRIUM_FACTORY_INPUT` in its env.

### Validation (lint)

Errors (definition refused): unsupported `version`; no steps; first step is a gate;
duplicate or malformed id; `on_reject` missing or not naming an earlier station; empty
`prompt`, `question`, `pass_label` or `reject_label`; artifact or show name with a path
separator; unknown `workspace`.

Warnings (shown, not blocking): station with neither `check` nor `artifact` ("finishes
only when you mark it done"); two gates in a row; last step is a station with no gate
after any station (fully unattended line); `rules` present ("prompt-level only").

## Trust

A check command comes from a file a teammate may have written. **(call)**

- The review screen lists every check command verbatim. Nothing runs before confirm.
- On confirm, the definition JSON is stored in SQLite. Runs use the stored copy and pin it
  at start (`factory_runs.definition_json`), never the file.
- When the file on disk differs from the stored copy, the factory shows "Definition changed
  on disk" and the user must review and confirm again before new runs use it.

## Import flow

1. `+` in the Factory navigator: pick a repo folder, then a Markdown file. Candidates
   offered: `.claude/skills/*/SKILL.md`, `.agentrium/**/*.md`, any `.md` that has a
   `.factory.json` sibling. Or browse.
2. If the sibling `.factory.json` exists: load it and go to step 4.
3. Otherwise Agentrium starts a normal, visible agent session in the repo with an initial
   prompt: read the file, write a definition matching the schema (embedded in the prompt)
   to an output path under the app data dir. The modal polls for that file. **(call:
   visible session, so it works with every initial-prompt agent and the user can see it.)**
4. Review screen: steps list with kind tags, every check command, lint errors and warnings.
   Confirm is disabled while errors exist.
5. Confirm: store in SQLite; if the definition came from the agent, also write
   `<stem>.factory.json` next to the Markdown. The source Markdown is never modified.

## Run lifecycle

Statuses: `queued`, `running`, `checking`, `waiting_gate`, `blocked`, `done`, `cancelled`.

- **Start.** Validate input. `worktree` mode: create a task worktree through the existing
  task flow, branch `agentrium/factory-<factory-slug>-<input-slug>`. `in_place`: workspace
  is the repo root. Create the run directory `<app data>/factory-runs/<run id>/`.
- **Station.** Agentrium opens a new agent session in the workspace with the rendered
  prompt as the initial prompt. Status `running`.
- **Station finished?** Evaluated when the session finishes a turn, when the session
  exits, and when the user clicks "Check now": if the station has an artifact and it does
  not exist, keep waiting. Otherwise run the check (status `checking`). No check: artifact
  present means pass. Neither: only "Mark done" passes it.
- **Pass.** Close the station's session, move to the next step.
- **Fail.** Attempt count for that station +1. Below the cap: close the session and start
  a new one for the same station with the last 4000 chars of check output in
  `{check_output}`. At the cap: status `blocked`, session left open. The user can "Allow 1
  more round" or cancel the run.
- **Gate.** Status `waiting_gate`. Nothing runs. Approve moves on. Reject requires a
  non-empty reason, resets the attempt counts of `on_reject` and every later station, and
  re-enters `on_reject` with `{reject_reason}` set.
- **End.** After the last step: `done`.
- **in_place queue. (call)** Per factory, at most one run may be `running` or `checking`.
  A run that would start a station while another holds the line becomes `queued` and
  starts when the line frees. Gates do not hold the line.
- **Restart.** Runs are loaded from SQLite. A run that was `running` or `checking` with no
  live session shows "Continue", which re-opens the same station (does not count as an
  attempt).
- Every transition appends a row to the run's event log (shown on the floor as the run's
  history).

The state machine is a pure function in Rust: `(definition, run, event) -> (run, action)`.
The frontend performs the actions that need a terminal (open session, close session) and
reports back. Gate answers come only from the gate dialog through one IPC command.

## UI

Reference sketches (throwaway): `.superpowers/brainstorm/67820-1795076675/content/
factory-sketch.html` and `sidebar-layout.html`.

- **Sidebar, Factory navigator**: fourth entry in the navigator switch, hue cyan
  `#38bdf8` (light `#0284c7`), with a violet count of gates waiting. Body: "Needs you"
  list, one card per factory (name, repo / file, run counts), "Add a factory from a repo
  file".
- **Sidebar, Sessions tab**: one group per factory that has open runs, above the session
  cards, one line per run (key, where it is). Hidden when there are none.
- **Factory floor** (main area tab, like the race tab): the line across the top with a
  count per step; one row per run with a progress track, status text and one action;
  right column "Needs you" (gates and blocked runs).
- **Gate dialog**: left, the `show` artifacts rendered as text; right, the gate notes,
  reason field, pass and reject buttons, and the line "Agentrium records this answer. The
  agent cannot answer a gate."
- **New run dialog**: factory picker when opened globally, the declared input field, Start.
- **New menu**: "Factory run" entry under Task and Race.
- Violet (`--attention-input`) means "your turn" everywhere.
- Feature flag `factoryEnabled` in Settings > General, default off. With it off, no
  factory UI is rendered. **(call)**

## Data

SQLite, local only, never synced:

- `factories(id, name, repo_path, source_path, definition_json, created_at, updated_at)`
- `factory_runs(id, factory_id, input, status, current_step, attempts_json,
  reject_reason, check_output, definition_json, workspace_path, branch, run_dir,
  terminal_id, created_at, updated_at)`
- `factory_run_events(id, run_id, at, step_id, kind, detail)`

## Error handling

Follows the repo rules: every command in `wrap_cmd`; validation, bad input, missing file
and failed check are `user_err` or data, never telemetry; user actions in the frontend
`toast.error` plus `reportInvokeFailure`; pollers swallow with a comment.

## Left to the builder

Component internals, exact Tailwind classes (match the sketches and existing race
components), test fixtures, and the wording of toasts.

## Later plans

1. Polled gates, gate effects, tool-call guard hooks per agent.
2. Improve: run statistics per step, stored rejection reasons as input, agent-proposed
   diff to the Markdown, "Describe your process" drafting.
