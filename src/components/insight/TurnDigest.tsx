import { useTerminalStore } from '../../store/terminalStore';
import { useAppStore } from '../../store/appStore';
import { toast } from '../../store/toastStore';
import { reportInvokeFailure } from '../../lib/errorReporter';
import { findLineInBuffer } from '../../lib/insightJump';
import { formatCost, formatElapsed, formatTokens } from '../../lib/races';
import type { FileTouch, InsightTurn } from '../../lib/insightModel';
import { ActivityBars } from './ActivityBars';
import { FilesTouched } from './FilesTouched';
import { StatTiles, type StatTile } from './StatTiles';
import { StructuredResult } from './StructuredResult';

const ABSOLUTE = /^([a-zA-Z]:[\\/]|\\\\|\/)/;
const JUMP_NEEDLE_CHARS = 60;

function resolvePath(cwd: string, path: string): string {
  if (ABSOLUTE.test(path) || !cwd) return path;
  const sep = cwd.includes('\\') ? '\\' : '/';
  return `${cwd.replace(/[\\/]+$/, '')}${sep}${path.replace(/^\.[\\/]/, '')}`;
}

/** Path relative to `root` (forward slashes), or null when `abs` is outside it. */
function relativeTo(root: string, abs: string): string | null {
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const p = abs.replace(/\\/g, '/');
  if (p.length > r.length && p.slice(0, r.length).toLowerCase() === r.toLowerCase() && p[r.length] === '/') {
    return p.slice(r.length + 1);
  }
  return null;
}

export function TurnDigest({ terminalId, turn }: { terminalId: string; turn: InsightTurn }) {
  const cwd = useTerminalStore((s) => s.terminals.get(terminalId)?.config.working_directory) ?? '';
  const metrics = useTerminalStore((s) => s.terminalMetrics.get(terminalId));
  const git = useTerminalStore((s) => s.gitInfoCache.get(terminalId));
  const repoRoot = git?.is_git_repo ? (git.worktree_root ?? git.main_repo_path) : null;

  const tiles: StatTile[] = [];
  if (turn.files.length > 0) tiles.push({ label: 'Files changed', value: String(turn.files.length) });
  if (turn.commands.length > 0) tiles.push({ label: 'Commands run', value: String(turn.commands.length) });
  if (turn.tests) {
    tiles.push({ label: 'Tests passed', value: String(turn.tests.passed), tone: 'ok' });
    tiles.push({ label: 'Tests failed', value: String(turn.tests.failed), tone: turn.tests.failed > 0 ? 'bad' : undefined });
  }
  if (turn.errors.length > 0) tiles.push({ label: 'Errors', value: String(turn.errors.length), tone: 'bad' });
  if (turn.tokens > 0) tiles.push({ label: 'Tokens', value: formatTokens(turn.tokens) });
  if (metrics) tiles.push({ label: 'Session cost', value: formatCost(metrics.costUsd) });

  const openFile = (f: FileTouch) => {
    useAppStore.getState().openFileTab(resolvePath(cwd, f.path))?.catch((err: unknown) => {
      toast.error('Could not open file', String(err));
      reportInvokeFailure('open_file_tab', err);
    });
  };

  const openDiff = repoRoot
    ? (f: FileTouch) => {
        const abs = resolvePath(cwd, f.path);
        const rel = relativeTo(repoRoot, abs);
        if (rel === null) {
          toast.info('Not in this repository', 'No diff is available for that file.');
          return;
        }
        useAppStore.getState().openDiffTab(abs, repoRoot, rel)?.catch((err: unknown) => {
          toast.error('Could not open diff', String(err));
          reportInvokeFailure('open_diff_tab', err);
        });
      }
    : undefined;

  const jump = (message: string) => {
    const xterm = useTerminalStore.getState().terminals.get(terminalId)?.xterm;
    const line = xterm ? findLineInBuffer(xterm, message.slice(0, JUMP_NEEDLE_CHARS)) : null;
    if (xterm && line !== null) xterm.scrollToLine(line);
    else toast.info('Not found in the terminal output');
  };

  return (
    <div className="space-y-2 px-2 py-2" data-testid="turn-digest">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 text-[12px] font-medium text-text-primary">{turn.headline}</span>
        {turn.durationMs !== null && (
          <span className="shrink-0 text-[11px] text-text-tertiary">{formatElapsed(turn.durationMs)}</span>
        )}
      </div>
      <StatTiles tiles={tiles} />
      <ActivityBars activity={turn.activity} />
      <FilesTouched files={turn.files} onOpen={openFile} onDiff={openDiff} />
      {turn.errors.length > 0 && (
        <ul className="space-y-1 rounded-md border border-red-400/30 bg-red-400/5 px-2 py-1">
          {turn.errors.slice(0, 5).map((e) => (
            <li key={e.toolUseId} className="flex items-center gap-2 text-[11px]">
              <span className="min-w-0 flex-1 truncate text-text-secondary" title={e.message}>
                {e.toolName}: {e.message}
              </span>
              <button
                type="button"
                onClick={() => jump(e.message)}
                className="shrink-0 text-accent-primary hover:underline"
              >
                Jump to output
              </button>
            </li>
          ))}
        </ul>
      )}
      {turn.finalText && <StructuredResult text={turn.finalText} />}
    </div>
  );
}
