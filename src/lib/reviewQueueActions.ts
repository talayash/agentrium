import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';
import { useAttentionStore } from '../store/attentionStore';
import { toast } from '../store/toastStore';
import { openPullRequestUrl } from './pullRequestActions';
import type { ReviewEntry } from './reviewQueue';

// User actions behind the Review Queue. None of them merges, pushes or
// discards anything: merging opens the existing finish dialog, and CI repair
// opens the existing modal, where the user confirms.

/** Bring a session to the front, out of grid/split and from behind any tab. */
function showSession(id: string): boolean {
  if (!useTerminalStore.getState().terminals.has(id)) return false;
  const app = useAppStore.getState();
  app.setSplitMode(false);
  if (app.gridMode) app.toggleGridMode();
  app.setActiveFilePath(null);
  useTerminalStore.getState().setActiveTerminal(id);
  return true;
}

function showChanges() {
  if (!useAppStore.getState().changesOpen) useAppStore.getState().toggleChanges();
}

function gone(entry: ReviewEntry): void {
  toast.info('Session no longer open', entry.stale ?? 'Dismiss the item, or reopen the session from the sidebar.');
}

/** Open the entry where it can be acted on: the race compare view, or the
 *  session (its terminal is the input flow) plus the changes panel when the
 *  item is about finished work. */
export function openReviewEntry(entry: ReviewEntry): void {
  const { item } = entry;
  if (item.raceId && !entry.stale) {
    useAppStore.getState().openRaceTab(item.raceId, item.title);
    return;
  }
  if (!entry.terminalId || !showSession(entry.terminalId)) { gone(entry); return; }
  if (entry.canOpenDiff && (item.kind === 'review' || item.kind === 'stopped' || item.kind === 'merge')) showChanges();
}

export function openReviewDiff(entry: ReviewEntry): void {
  if (!entry.terminalId || !showSession(entry.terminalId)) { gone(entry); return; }
  showChanges();
}

/** Opens FinishTaskDialog; the merge itself needs the user's click there. */
export function finishReviewTask(entry: ReviewEntry): void {
  if (!entry.terminalId || !showSession(entry.terminalId)) { gone(entry); return; }
  useAppStore.getState().openFinishTask(entry.terminalId, false);
}

export function fixReviewCi(entry: ReviewEntry): void {
  if (!entry.terminalId || !useTerminalStore.getState().terminals.has(entry.terminalId)) { gone(entry); return; }
  useAppStore.getState().openCiRepair(entry.terminalId);
}

export function openReviewPr(entry: ReviewEntry): void {
  if (entry.item.url) openPullRequestUrl(entry.item.url);
}

// A "Ready to merge" entry may carry a folded session item; act on both so
// the folded one does not resurface on its own.
function eachSlot(entry: ReviewEntry, fn: (terminalId: string, channel: ReviewEntry['channel']) => void) {
  fn(entry.item.terminalId, entry.channel);
  if (entry.kinds.length > 1) fn(entry.item.terminalId, 'session');
}

export function dismissReviewEntry(entry: ReviewEntry): void {
  eachSlot(entry, (id, channel) => useAttentionStore.getState().dismiss(id, channel));
}

export function markEntryReviewed(entry: ReviewEntry): void {
  eachSlot(entry, (id, channel) => useAttentionStore.getState().markReviewed(id, channel));
}

export function revisitReviewEntry(entry: ReviewEntry): void {
  eachSlot(entry, (id, channel) => useAttentionStore.getState().revisit(id, channel));
}
