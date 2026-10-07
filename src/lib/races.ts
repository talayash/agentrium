import { invoke } from '@tauri-apps/api/core';
import { allAgentSpecs, isCustomAgent, type AgentKind } from './agents';
import { reportInvokeFailure } from './errorReporter';
import { needsStaging, promptDeliveryFor, resolveLaunchConfig, setupFilesFor, type MergeMode, type TaskInfo, type TaskProfile } from './tasks';
import type { AttentionKind } from '../store/attentionStore';
import type { TerminalConfig } from '../store/terminalStore';
import type { SessionState } from './terminalState';

// Defined in tasks.ts so plain task launches share them.
export { needsStaging, promptDeliveryFor } from './tasks';

// ---------------------------------------------------------------------------
// Wire types (mirror races.rs)
// ---------------------------------------------------------------------------

export const MIN_CONTENDERS = 2;
export const MAX_CONTENDERS = 4;

export type RaceStatus = 'running' | 'judging' | 'decided' | 'abandoned';
export type ContenderOutcome = 'pending' | 'winner' | 'discarded' | 'kept' | 'left';

/** Snapshot recorded on the race row when it is decided (history). */
export interface ContenderStats {
  elapsedMs: number | null;
  costUsd: number | null;
  tokens: number | null;
  filesChanged: number;
  added: number;
  removed: number;
  check: CheckVerdict | null;
}

export interface RaceContender {
  idx: number;
  agent: AgentKind;
  model: string | null;
  args: string[];
  label: string;
  branch: string;
  worktreePath: string;
  terminalId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  outcome: ContenderOutcome | string;
  stats: ContenderStats | null;
}

export interface Race {
  id: string;
  title: string;
  prompt: string;
  repoPath: string;
  baseBranch: string;
  baseSha: string;
  createdAt: string;
  status: RaceStatus;
  winnerTask: string | null;
  decidedAt: string | null;
  checkCommand: string | null;
  contenders: RaceContender[];
}

export interface RaceFileStat {
  path: string;
  /** `A`, `M`, `D`, `T`, or `??` for an untracked new file. */
  status: string;
  added: number | null;
  removed: number | null;
}

export interface ContenderDiff {
  worktree_path: string;
  exists: boolean;
  files: RaceFileStat[];
  added: number;
  removed: number;
  commits_ahead: number;
  uncommitted: number;
}

export interface RaceCheckResult {
  exit_code: number | null;
  timed_out: boolean;
  cancelled: boolean;
  duration_ms: number;
  output_tail: string;
  truncated: boolean;
}

export type CheckVerdict = 'pass' | 'fail' | 'timeout' | 'cancelled';

export interface FinishResult {
  merged: boolean;
  worktree_removed: boolean;
  branch_deleted: boolean;
  warning: string | null;
}

export interface ContenderFinish {
  worktree_path: string;
  result: FinishResult | null;
  error: string | null;
}

export interface DecideRaceResult {
  winner: FinishResult | null;
  losers: ContenderFinish[];
}

export type WinnerAction =
  | { kind: 'merge'; mode: MergeMode; message: string | null }
  | { kind: 'pull-request' };

export interface LoserChoice {
  worktree_path: string;
  keep_branch: boolean;
  confirm_unmerged: boolean;
  /** The backend re-checks uncommitted work at discard time and refuses
   *  without this, so changes written after the dialog looked survive. */
  confirm_uncommitted: boolean;
}

export interface DecideRaceRequest {
  race_id: string;
  winner_worktree: string;
  winner_action: WinnerAction;
  losers: LoserChoice[];
  stats: Record<string, ContenderStats>;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

export const getRace = (raceId: string) => invoke<Race>('get_race', { raceId });
export const listRaces = () => invoke<Race[]>('list_races');
export const getRaceDiffstat = (raceId: string) => invoke<ContenderDiff[]>('get_race_diffstat', { raceId });
export const getRaceFile = (raceId: string, source: string, path: string) =>
  invoke<string | null>('get_race_file', { raceId, source, path });
export const setRaceStatus = (raceId: string, status: 'running' | 'judging') =>
  invoke<void>('set_race_status', { raceId, status });
export const setRaceCheckCommand = (raceId: string, command: string | null) =>
  invoke<void>('set_race_check_command', { raceId, command });
export const runRaceCheck = (raceId: string, worktreePath: string, runId: string, timeoutSecs: number) =>
  invoke<RaceCheckResult>('run_race_check', { raceId, worktreePath, runId, timeoutSecs });
export const cancelRaceCheck = (runId: string) => invoke<boolean>('cancel_race_check', { runId });
/** Forget a finished race (decided or abandoned). */
export const deleteRace = (raceId: string) => invoke<void>('delete_race', { raceId });
export const decideRace = (request: DecideRaceRequest) => invoke<DecideRaceResult>('decide_race', { request });
export const abandonRace = (raceId: string, contenders: LoserChoice[], stats: Record<string, ContenderStats>) =>
  invoke<ContenderFinish[]>('abandon_race', { request: { race_id: raceId, contenders, stats } });
export const updateRaceContender = (
  raceId: string, worktreePath: string,
  patch: { terminal_id?: string | null; started_at?: string | null; finished_at?: string | null },
) => invoke<void>('update_race_contender', { raceId, worktreePath, patch });

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Path identity across separator style and (Windows) case. */
export function pathKey(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/** Display name for any agent kind, including a deleted custom agent. */
export function agentName(kind: AgentKind): string {
  const spec = allAgentSpecs().find((s) => s.kind === kind);
  if (spec) return spec.displayName;
  return isCustomAgent(kind) ? 'Custom agent' : kind;
}

export function contenderLabel(agent: AgentKind, model: string | null | undefined): string {
  const m = model?.trim();
  return m ? `${agentName(agent)} · ${m}` : agentName(agent);
}

export function raceTabName(title: string, label: string): string {
  return `Race: ${title.trim()} · ${label}`;
}

/** Replace any `--model` the args carry with the contender's model. */
export function argsWithModel(args: string[], model: string | null | undefined): string[] {
  const m = model?.trim();
  if (!m) return [...args];
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model') { i++; continue; }
    if (args[i].startsWith('--model=')) continue;
    out.push(args[i]);
  }
  return [...out, '--model', m];
}

// --- State derivation ------------------------------------------------------

export type ContenderState = 'starting' | 'working' | 'needs-input' | 'done' | 'exited' | 'error';

export interface ContenderSignals {
  /** A live terminal is working in the contender's worktree. */
  terminalExists: boolean;
  status?: TerminalConfig['status'];
  /** Inferred session state from the terminal poller. */
  inferred?: SessionState;
  /** The contender's current attention item (session channel). */
  attention?: AttentionKind | null;
  /** The user marked it done. */
  manualDone: boolean;
  /** The terminal was busy at least once (so "idle" now means it settled). */
  seenBusy: boolean;
}

/** One contender's state from the same signals the attention inbox uses. A
 *  contender is done when it reaches review, or idle after having worked. */
export function deriveContenderState(s: ContenderSignals): ContenderState {
  if (s.manualDone) return 'done';
  if (!s.terminalExists) return 'exited';
  if (s.status === 'Error' || s.attention === 'error') return 'error';
  if (s.status === 'Stopped' || s.attention === 'stopped') return 'exited';
  if (s.attention === 'input' || s.inferred === 'waiting') return 'needs-input';
  if (s.attention === 'review') return 'done';
  if (s.inferred === 'busy') return 'working';
  if (s.inferred === 'idle' && s.seenBusy) return 'done';
  return 'starting';
}

/** No longer producing work: compare-ready. */
export function isSettled(state: ContenderState): boolean {
  return state === 'done' || state === 'exited' || state === 'error';
}

export function allSettled(states: ContenderState[]): boolean {
  return states.length > 0 && states.every(isSettled);
}

export const CONTENDER_STATE_LABEL: Record<ContenderState, string> = {
  starting: 'Starting', working: 'Working', 'needs-input': 'Needs input', done: 'Done', exited: 'Exited', error: 'Error',
};

// --- Checks ------------------------------------------------------------------

export function checkVerdict(r: RaceCheckResult | null | undefined): CheckVerdict | null {
  if (!r) return null;
  if (r.cancelled) return 'cancelled';
  if (r.timed_out) return 'timeout';
  return r.exit_code === 0 ? 'pass' : 'fail';
}

export function checkSummary(r: RaceCheckResult | null | undefined): string {
  const v = checkVerdict(r);
  if (!r || !v) return 'not run';
  if (v === 'pass') return 'passed';
  if (v === 'fail') return `failed (exit ${r.exit_code ?? '?'})`;
  return v === 'timeout' ? 'timed out' : 'cancelled';
}

// --- File matrix ---------------------------------------------------------------

export interface MatrixCell {
  touched: boolean;
  status: string | null;
  added: number | null;
  removed: number | null;
}

export interface MatrixRow {
  path: string;
  cells: MatrixCell[];
  touchedBy: number;
}

/** Which contenders touched which file, one cell per contender (in contender
 *  order; a missing diff is a column of untouched cells). Files touched by
 *  more contenders come first, then by path. */
export function buildFileMatrix(diffs: (ContenderDiff | null | undefined)[]): MatrixRow[] {
  const byPath = new Map<string, MatrixCell[]>();
  diffs.forEach((d, col) => {
    for (const f of d?.files ?? []) {
      let cells = byPath.get(f.path);
      if (!cells) {
        cells = diffs.map(() => ({ touched: false, status: null, added: null, removed: null }));
        byPath.set(f.path, cells);
      }
      cells[col] = { touched: true, status: f.status, added: f.added, removed: f.removed };
    }
  });
  return [...byPath.entries()]
    .map(([path, cells]) => ({ path, cells, touchedBy: cells.filter((c) => c.touched).length }))
    .sort((a, b) => b.touchedBy - a.touchedBy || a.path.localeCompare(b.path));
}

// --- Judge prompt ------------------------------------------------------------

const JUDGE_MAX_FILES = 60;
const JUDGE_TAIL_LINES = 20;

/** Comparison brief staged in a judge agent's prompt editor. Advisory only:
 *  it asks the judge not to modify anything and never triggers a merge. */
export function buildJudgePrompt(
  race: Pick<Race, 'title' | 'prompt' | 'baseBranch' | 'baseSha' | 'checkCommand' | 'contenders'>,
  diffs: (ContenderDiff | null | undefined)[],
  checks: (RaceCheckResult | null | undefined)[],
): string {
  const n = race.contenders.length;
  const lines: string[] = [
    `You are judging a race: ${n} coding agents attempted the same task independently, each in its own git worktree, starting from ${race.baseBranch} at ${race.baseSha.slice(0, 12)}.`,
    'Inspect each worktree (read files, run `git diff ' + race.baseSha.slice(0, 12) + '` inside it), but do NOT modify any of them and do not merge anything. Your answer is advisory.',
    '',
    '## Task given to every contender',
    '',
    race.prompt.trim(),
    '',
  ];
  race.contenders.forEach((c, i) => {
    const d = diffs[i];
    const check = checks[i];
    lines.push(`## Contender ${String.fromCharCode(65 + i)}: ${c.label}`, '');
    lines.push(`- Worktree: ${c.worktreePath}`);
    lines.push(`- Branch: ${c.branch}`);
    if (d) {
      lines.push(`- ${d.commits_ahead} commit(s) on top of the base, ${d.uncommitted} uncommitted change(s)`);
      lines.push(`- ${d.files.length} file(s) changed, +${d.added} -${d.removed}`);
    } else {
      lines.push('- Diff stats unavailable');
    }
    lines.push(`- Check${race.checkCommand ? ` (\`${race.checkCommand}\`)` : ''}: ${checkSummary(check)}`);
    if (d && d.files.length > 0) {
      lines.push('', '```');
      for (const f of d.files.slice(0, JUDGE_MAX_FILES)) {
        lines.push(`${f.added ?? '-'}\t${f.removed ?? '-'}\t${f.status === '??' ? 'A' : f.status}\t${f.path}`);
      }
      if (d.files.length > JUDGE_MAX_FILES) lines.push(`... and ${d.files.length - JUDGE_MAX_FILES} more`);
      lines.push('```');
    }
    const v = checkVerdict(check);
    if (check && v && v !== 'pass' && check.output_tail.trim()) {
      const tail = check.output_tail.trimEnd().split('\n').slice(-JUDGE_TAIL_LINES).join('\n');
      lines.push('', 'Check output (tail):', '```', tail, '```');
    }
    lines.push('');
  });
  lines.push(
    '## What to report',
    '',
    '1. For each contender: does it solve the task correctly and completely? Note bugs, missing pieces and changes outside the task\'s scope.',
    '2. Compare code quality, tests and risk.',
    '3. Recommend one winner (by letter and label) with your reasons, and list anything it should still fix before merging.',
  );
  return lines.join('\n');
}

// --- Deciding -----------------------------------------------------------------

export interface LoserPlan {
  worktreePath: string;
  label: string;
  branch: string;
  /** Remove the worktree but keep the branch. */
  keepBranch: boolean;
  /** Commits the base lacks, and uncommitted changes, that a discard loses. */
  ahead: number;
  uncommitted: number;
  /** The user confirmed losing that work. */
  confirmed: boolean;
}

export type DecidePlan =
  | { ok: true; request: DecideRaceRequest }
  | { ok: false; needsConfirmation: LoserPlan[] };

/** What a discard would lose, or null if nothing. */
export function loserLoss(l: Pick<LoserPlan, 'ahead' | 'uncommitted'>): string | null {
  const parts: string[] = [];
  if (l.ahead > 0) parts.push(`${l.ahead} unmerged commit(s)`);
  if (l.uncommitted > 0) parts.push(`${l.uncommitted} uncommitted change(s)`);
  return parts.length ? parts.join(' and ') : null;
}

/** Build the decide request. Like FinishTaskDialog, discarding a loser that
 *  would lose work needs an explicit confirmation first. */
export function planDecision(
  raceId: string,
  winnerWorktree: string,
  winner: WinnerAction,
  losers: LoserPlan[],
  stats: Record<string, ContenderStats>,
): DecidePlan {
  const unconfirmed = losers.filter((l) => !l.keepBranch && loserLoss(l) && !l.confirmed);
  if (unconfirmed.length > 0) return { ok: false, needsConfirmation: unconfirmed };
  return {
    ok: true,
    request: {
      race_id: raceId,
      winner_worktree: winnerWorktree,
      winner_action: winner.kind === 'merge'
        ? { kind: 'merge', mode: winner.mode, message: winner.message?.trim() || null }
        : { kind: 'pull-request' },
      losers: losers.map((l) => ({
        worktree_path: l.worktreePath,
        keep_branch: l.keepBranch,
        confirm_unmerged: !l.keepBranch && l.ahead > 0,
        confirm_uncommitted: !l.keepBranch && l.uncommitted > 0,
      })),
      stats,
    },
  };
}

// --- Formatting and history ----------------------------------------------------

export function formatElapsed(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return '–';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function formatCost(usd: number | null | undefined): string {
  if (usd == null) return '–';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

export function formatTokens(n: number | null | undefined): string {
  if (n == null) return '–';
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n);
}

const VERDICT_TEXT: Record<CheckVerdict, string> = { pass: 'pass', fail: 'fail', timeout: 'timeout', cancelled: 'cancelled' };

/** Markdown appended to the winner's PR body. */
export function racedAgainstTable(race: Pick<Race, 'contenders'>, winnerWorktree: string, stats: Record<string, ContenderStats>): string {
  const rows = race.contenders.map((c) => {
    const s = Object.entries(stats).find(([p]) => samePath(p, c.worktreePath))?.[1];
    const isWinner = samePath(c.worktreePath, winnerWorktree);
    const name = isWinner ? `**${c.label}** (winner)` : c.label;
    return `| ${name} | ${formatElapsed(s?.elapsedMs)} | ${formatCost(s?.costUsd)} | ${s?.filesChanged ?? '–'} | +${s?.added ?? 0} / -${s?.removed ?? 0} | ${s?.check ? VERDICT_TEXT[s.check] : '–'} |`;
  });
  const others = race.contenders.filter((c) => !samePath(c.worktreePath, winnerWorktree)).map((c) => c.label);
  return [
    '### Raced against',
    '',
    `Picked in an Agentrium race against ${others.join(', ') || 'no one'}.`,
    '',
    '| Contender | Time | Cost | Files | +/- | Check |',
    '|---|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

export interface WinRate {
  key: string;
  label: string;
  races: number;
  wins: number;
  rate: number;
}

const rateKey = (c: Pick<RaceContender, 'agent' | 'model'>) => `${c.agent}|${c.model?.trim() ?? ''}`;

/** Local-only win rate per agent/model across decided races. */
export function winRates(races: Pick<Race, 'status' | 'contenders'>[]): WinRate[] {
  const acc = new Map<string, WinRate>();
  for (const r of races) {
    if (r.status !== 'decided') continue;
    for (const c of r.contenders) {
      const key = rateKey(c);
      const row = acc.get(key) ?? { key, label: c.label, races: 0, wins: 0, rate: 0 };
      row.races += 1;
      if (c.outcome === 'winner') row.wins += 1;
      acc.set(key, row);
    }
  }
  return [...acc.values()]
    .map((r) => ({ ...r, rate: r.races ? r.wins / r.races : 0 }))
    .sort((a, b) => b.rate - a.rate || b.races - a.races || a.label.localeCompare(b.label));
}

export function winRateFor(rates: WinRate[], agent: AgentKind, model: string | null | undefined): WinRate | null {
  return rates.find((r) => r.key === rateKey({ agent, model: model ?? null })) ?? null;
}

/** Average recorded cost per contender in past races, or null without data. */
export function averageContenderCost(races: Pick<Race, 'contenders'>[]): { avg: number; samples: number } | null {
  const costs = races.flatMap((r) => r.contenders.map((c) => c.stats?.costUsd)).filter((c): c is number => typeof c === 'number');
  if (costs.length === 0) return null;
  return { avg: costs.reduce((a, b) => a + b, 0) / costs.length, samples: costs.length };
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

export interface RaceContenderInput {
  agent: AgentKind;
  model: string | null;
}

export interface LaunchRaceParams {
  repoPath: string;
  title: string;
  prompt: string;
  baseBranch?: string | null;
  contenders: RaceContenderInput[];
  checkCommand?: string | null;
  profile?: TaskProfile | null;
}

export interface LaunchRaceResult {
  race: Race;
  terminalIds: string[];
  /** Terminals whose prompt was staged rather than delivered at spawn. */
  staged: string[];
}

export function taskForContender(race: Race, c: RaceContender): TaskInfo {
  return {
    title: race.title, branch: c.branch, baseBranch: race.baseBranch,
    worktreePath: c.worktreePath, repoPath: race.repoPath, raceId: race.id,
  };
}

/**
 * Open a new session in a contender's worktree (its terminal was closed or
 * the app restarted without restoring it). Continues the agent's most recent
 * conversation in that worktree; the task prompt is never sent again.
 */
export async function reopenContender(race: Race, c: RaceContender): Promise<string> {
  const { useTerminalStore } = await import('../store/terminalStore');
  const { useAgentRegistryStore } = await import('../store/agentRegistryStore');
  const name = raceTabName(race.title, c.label);
  const id = await useTerminalStore.getState().createTerminal(
    name, c.worktreePath, c.args, {}, undefined, name, undefined, undefined, true, undefined,
    c.agent, useAgentRegistryStore.getState().defaultBindingsFor(c.agent), taskForContender(race, c),
  );
  updateRaceContender(race.id, c.worktreePath, { terminal_id: id })
    .catch((err) => reportInvokeFailure('update_race_contender', err));
  return id;
}

/**
 * Start a race: one backend call creates every worktree from the same base
 * SHA, then each contender gets a terminal. The task reaches each agent at
 * spawn when it supports an initial prompt, else it is staged in that
 * terminal's prompt editor (never typed into the PTY). If any terminal fails
 * to start, every contender is closed and discarded again.
 */
export async function launchRace(p: LaunchRaceParams): Promise<LaunchRaceResult> {
  if (p.contenders.length < MIN_CONTENDERS || p.contenders.length > MAX_CONTENDERS) {
    throw new Error(`A race needs ${MIN_CONTENDERS} to ${MAX_CONTENDERS} contenders.`);
  }
  for (const c of p.contenders) {
    if (!allAgentSpecs().some((s) => s.kind === c.agent)) throw new Error('A selected agent is no longer available.');
  }
  const { useAppStore } = await import('../store/appStore');
  const { useTerminalStore } = await import('../store/terminalStore');
  const { useAgentRegistryStore } = await import('../store/agentRegistryStore');
  const app = useAppStore.getState();
  const launches = p.contenders.map((c) => {
    const cfg = resolveLaunchConfig(c.agent, p.profile, app.defaultAgentArgs,
      useAgentRegistryStore.getState().defaultBindingsFor(c.agent));
    return { ...c, ...cfg, args: argsWithModel(cfg.args, c.model), label: contenderLabel(c.agent, c.model) };
  });
  const race = await invoke<Race>('start_race', {
    request: {
      repo_path: p.repoPath,
      title: p.title,
      prompt: p.prompt,
      base_branch: p.baseBranch?.trim() || null,
      contenders: launches.map((l) => ({ agent: l.agent, model: l.model?.trim() || null, args: l.args, label: l.label })),
      worktree_root: app.taskWorktreeRoot.trim() || null,
      setup_files: setupFilesFor(p.repoPath, app.taskSetupFiles),
      check_command: p.checkCommand?.trim() || null,
    },
  });

  const terminalIds: string[] = [];
  const staged: string[] = [];
  try {
    for (const [i, c] of race.contenders.entries()) {
      const l = launches[i];
      const name = raceTabName(race.title, c.label);
      const deliver = promptDeliveryFor(c.agent) === 'argv';
      const id = await useTerminalStore.getState().createTerminal(
        name, c.worktreePath, l.args, l.envVars, undefined, name, undefined, undefined, false, undefined,
        c.agent, l.bindings, taskForContender(race, c), { initialPrompt: deliver ? race.prompt : undefined },
      );
      terminalIds.push(id);
      const delivery = useTerminalStore.getState().terminals.get(id)?.config.prompt_delivery;
      if (needsStaging(delivery)) {
        // Unknown input state (trust or login prompt, unsupported CLI): stage
        // it; the user sends it with "Send to all waiting" once ready.
        app.setPromptDraft(id, race.prompt);
        staged.push(id);
      }
      const startedAt = new Date().toISOString();
      c.terminalId = id;
      c.startedAt = startedAt;
      // Timing is informational: a failed write must not abort the race.
      updateRaceContender(race.id, c.worktreePath, { terminal_id: id, started_at: startedAt })
        .catch((err) => reportInvokeFailure('update_race_contender', err));
    }
  } catch (err) {
    for (const id of terminalIds) {
      await useTerminalStore.getState().closeTerminal(id).catch((e) => reportInvokeFailure('close_terminal', e));
    }
    // Fresh branches with no work: discarding loses nothing.
    await abandonRace(race.id, race.contenders.map((c) => ({
      worktree_path: c.worktreePath, keep_branch: false, confirm_unmerged: true, confirm_uncommitted: true,
    })), {})
      .catch((e) => reportInvokeFailure('abandon_race', e));
    throw err;
  }

  // One grid cell per contender, using the existing layouts.
  app.setSplitMode(false);
  app.setGridTerminals(terminalIds);
  app.setGridMode(true);
  app.setActiveFilePath(null);
  return { race, terminalIds, staged };
}
