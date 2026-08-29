import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  X,
  ArrowRight,
  ChevronDown,
  Loader2,
  Upload,
  AlertTriangle,
  Info,
  Zap,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';
import { toast } from '../store/toastStore';
import type { PushPreview, PushMode } from '../types/git';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';

function basename(p: string): string {
  const clean = p.replace(/[\\/]+$/, '');
  const parts = clean.split(/[\\/]/);
  return parts[parts.length - 1] || clean;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.round(day / 7);
  if (wk < 5) return `${wk}w ago`;
  return new Date(iso).toLocaleDateString();
}

export function PushModal() {
  const closePushModal = useAppStore((s) => s.closePushModal);
  const repoPath = useAppStore((s) => s.pushModalRepoPath) || '';

  const [preview, setPreview] = useState<PushPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pushError, setPushError] = useState<string | null>(null);
  const [remote, setRemote] = useState('');
  const [remoteBranch, setRemoteBranch] = useState('');
  const [pushTags, setPushTags] = useState(false);
  const [busy, setBusy] = useState(false);
  const [remoteMenuOpen, setRemoteMenuOpen] = useState(false);
  const [pushMenuOpen, setPushMenuOpen] = useState(false);
  const [forceConfirmOpen, setForceConfirmOpen] = useState(false);

  const remoteMenuRef = useRef<HTMLDivElement>(null);
  const pushMenuRef = useRef<HTMLDivElement>(null);

  const repoName = useMemo(() => basename(repoPath), [repoPath]);

  const loadPreview = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setPushError(null);
    try {
      const p = await invoke<PushPreview>('get_push_preview', { path: repoPath });
      setPreview(p);
      setRemote(p.default_remote);
      setRemoteBranch(p.default_remote_branch);
    } catch (err) {
      setLoadError(typeof err === 'string' ? err : 'Failed to load push preview');
    } finally {
      setLoading(false);
    }
  }, [repoPath]);

  useEffect(() => {
    if (repoPath) void loadPreview();
  }, [repoPath, loadPreview]);

  // Close popovers on outside click
  useEffect(() => {
    if (!remoteMenuOpen && !pushMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (remoteMenuOpen && remoteMenuRef.current && !remoteMenuRef.current.contains(e.target as Node)) {
        setRemoteMenuOpen(false);
      }
      if (pushMenuOpen && pushMenuRef.current && !pushMenuRef.current.contains(e.target as Node)) {
        setPushMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [remoteMenuOpen, pushMenuOpen]);

  const refreshGitInfoForPath = useCallback((path: string) => {
    const { terminals, fetchGitInfo } = useTerminalStore.getState();
    for (const t of terminals.values()) {
      if (t.config.working_directory === path) void fetchGitInfo(t.config.id);
    }
  }, []);

  const runPush = useCallback(
    async (mode: PushMode) => {
      if (!preview) return;
      setBusy(true);
      setPushError(null);
      try {
        await invoke('git_push', {
          path: repoPath,
          remote,
          remoteBranch,
          mode,
          pushTags,
          setUpstream: !preview.has_upstream,
        });
        toast.success(
          'Push',
          `Pushed ${preview.ahead} commit${preview.ahead === 1 ? '' : 's'} to ${remote}/${remoteBranch}`
        );
        refreshGitInfoForPath(repoPath);
        closePushModal();
      } catch (err) {
        const msg = typeof err === 'string' ? err : 'Push failed';
        setPushError(msg);
        toast.error('Push failed', msg);
      } finally {
        setBusy(false);
      }
    },
    [preview, repoPath, remote, remoteBranch, pushTags, refreshGitInfoForPath, closePushModal]
  );

  const canPush =
    !!preview &&
    preview.commits.length > 0 &&
    remoteBranch.trim().length > 0 &&
    !busy;

  // Backdrop click and Escape are handled by <Modal>; ignore them while a push
  // is in flight so the dialog can't be dismissed mid-operation.
  const handleClose = useCallback(() => {
    if (!busy) closePushModal();
  }, [busy, closePushModal]);

  return (
    <Modal
      onClose={handleClose}
      closeOn="click"
      panelClassName="w-[92vw] max-w-[840px] h-[72vh] max-h-[620px] grid grid-rows-[44px_40px_1fr_auto_56px]"
    >
        {/* Header */}
        <div className="flex items-center justify-between px-3 bg-elevation-1 border-b border-[var(--ij-divider-soft)]">
          <span className="text-text-primary text-[13px] font-semibold truncate">
            Push Commits to {repoName || 'repository'}
          </span>
          <button
            onClick={() => { if (!busy) closePushModal(); }}
            className="p-1.5 rounded hover:bg-fill-hover text-text-tertiary transition-colors disabled:opacity-40"
            disabled={busy}
            title="Close (Esc)"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        {/* Branch route strip */}
        <div className="flex items-center gap-2 px-3 bg-accent-primary/15 border-b border-[var(--ij-divider-soft)] text-[12.5px]">
          {preview ? (
            <>
              <span className="font-mono text-text-primary truncate max-w-[180px]" title={preview.local_branch}>
                {preview.local_branch}
              </span>
              <ArrowRight size={12} className="text-text-tertiary flex-shrink-0" />

              {preview.remotes.length > 1 ? (
                <div className="relative" ref={remoteMenuRef}>
                  <button
                    onClick={() => setRemoteMenuOpen((v) => !v)}
                    disabled={busy}
                    className="flex items-center gap-1 h-6 px-2 rounded-[4px] hover:bg-fill-active text-accent-primary font-mono transition-colors disabled:opacity-50"
                  >
                    {remote}
                    <ChevronDown size={11} className="text-text-tertiary" />
                  </button>
                  {remoteMenuOpen && (
                    <div className="absolute left-0 top-full mt-1 z-10 w-[160px] bg-elevation-3 border border-[var(--ij-divider-soft)] rounded-lg overflow-hidden py-1">
                      {preview.remotes.map((r) => (
                        <button
                          key={r}
                          onClick={() => { setRemote(r); setRemoteMenuOpen(false); }}
                          className={`w-full text-left px-3 py-1.5 text-[12px] font-mono transition-colors ${
                            r === remote
                              ? 'bg-accent-primary/15 text-accent-primary'
                              : 'text-text-primary hover:bg-fill-hover'
                          }`}
                        >
                          {r}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <span className="font-mono text-accent-primary">{remote}</span>
              )}

              <span className="text-text-tertiary">:</span>

              <input
                type="text"
                value={remoteBranch}
                onChange={(e) => setRemoteBranch(e.target.value)}
                disabled={busy}
                spellCheck={false}
                className="font-mono text-text-primary bg-elevation-0 border border-[var(--ij-divider-soft)] rounded-[4px] h-6 px-2 text-[12px] focus:outline-none focus:border-accent-primary disabled:opacity-50 min-w-[180px] flex-1 max-w-[320px]"
                placeholder="branch name"
                aria-label="Remote branch"
              />
            </>
          ) : (
            <span className="text-text-tertiary">Loading…</span>
          )}
        </div>

        {/* Body */}
        <div className="overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center h-full text-text-tertiary text-[12px]">
              <Loader2 size={14} className="animate-spin mr-2" />
              Loading push preview…
            </div>
          )}

          {!loading && loadError && (
            <div className="flex flex-col items-center justify-center h-full px-6 text-center gap-3">
              <AlertTriangle size={24} className="text-error" />
              <div className="text-text-primary text-[13px] font-medium">Can't push</div>
              <div className="text-text-tertiary text-[12px] max-w-[440px]">{loadError}</div>
              <Button variant="secondary" size="sm" className="mt-1" onClick={() => void loadPreview()}>
                Retry
              </Button>
            </div>
          )}

          {!loading && !loadError && preview && (
            <div className="p-3 space-y-2">
              {!preview.has_upstream && (
                <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-sky-500/10 border border-sky-500/30 text-[12px] text-sky-200">
                  <Info size={13} className="mt-0.5 flex-shrink-0" />
                  <span>
                    New branch - pushing will set upstream to{' '}
                    <span className="font-mono">{remote}/{remoteBranch || preview.default_remote_branch}</span>.
                  </span>
                </div>
              )}

              {preview.behind > 0 && (
                <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-amber-500/10 border border-amber-500/30 text-[12px] text-amber-200">
                  <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />
                  <span>
                    Remote has {preview.behind} new commit{preview.behind === 1 ? '' : 's'} not in your branch.
                    Pull first to avoid a non-fast-forward, or use Force Push (with lease).
                  </span>
                </div>
              )}

              {preview.commits.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center gap-2">
                  <span className="text-text-primary text-[13px]">No new commits</span>
                  <span className="text-text-tertiary text-[12px]">Your branch is up to date with the remote.</span>
                </div>
              ) : (
                <div className="border border-[var(--ij-divider-soft)] rounded-md overflow-hidden">
                  <div className="px-3 py-1.5 bg-elevation-1 text-[10.5px] uppercase tracking-wider font-semibold text-text-tertiary border-b border-[var(--ij-divider-soft)]">
                    {preview.ahead} commit{preview.ahead === 1 ? '' : 's'} to push
                  </div>
                  <ul>
                    {preview.commits.map((c) => (
                      <li
                        key={c.sha}
                        className="flex items-center gap-3 px-3 py-1.5 border-b border-[var(--ij-divider-soft)] last:border-b-0 hover:bg-fill-hover transition-colors"
                      >
                        <span className="font-mono text-[11px] text-text-tertiary w-[60px] flex-shrink-0">
                          {c.short_sha}
                        </span>
                        <span className="text-[12.5px] text-text-primary flex-1 truncate" title={c.subject}>
                          {c.subject}
                        </span>
                        <span className="text-[11px] text-text-tertiary truncate max-w-[140px]" title={c.author}>
                          {c.author}
                        </span>
                        <span className="text-[11px] text-text-tertiary flex-shrink-0">
                          {relativeTime(c.time_iso)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Inline push error strip */}
        {pushError && (
          <div className="flex items-start gap-2 px-3 py-2 bg-error/10 border-t border-error/30 text-[12px] text-error">
            <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />
            <span className="flex-1 break-words">{pushError}</span>
            <button
              onClick={() => setPushError(null)}
              className="text-error/70 hover:text-error transition-colors flex-shrink-0"
              aria-label="Dismiss error"
            >
              <X size={12} />
            </button>
          </div>
        )}

        {/* Force-with-lease confirm overlay */}
        {forceConfirmOpen && (
          <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-10">
            <div className="bg-elevation-1 border border-amber-500/40 rounded-lg p-5 max-w-[440px] mx-4">
              <div className="flex items-start gap-3">
                <Zap size={20} className="text-amber-400 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="text-text-primary text-[13px] font-semibold mb-1">Force Push (with lease)?</div>
                  <div className="text-text-secondary text-[12px] leading-relaxed">
                    Force-push to <span className="font-mono text-text-primary">{remote}/{remoteBranch}</span>.
                    Will refuse if the remote has commits you haven't fetched.
                  </div>
                </div>
              </div>
              <div className="flex justify-end gap-2 mt-4">
                <Button variant="secondary" size="sm" onClick={() => setForceConfirmOpen(false)}>
                  Cancel
                </Button>
                <button
                  onClick={() => { setForceConfirmOpen(false); void runPush('force_with_lease'); }}
                  className="h-7 px-3 rounded-md text-[12px] font-medium bg-amber-500/90 hover:bg-amber-500 text-black transition-colors"
                >
                  Force Push
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between px-3 bg-elevation-1 border-t border-[var(--ij-divider-soft)]">
          <label className="flex items-center gap-2 text-[12px] text-text-secondary cursor-pointer select-none">
            <input
              type="checkbox"
              checked={pushTags}
              onChange={(e) => setPushTags(e.target.checked)}
              disabled={busy}
              className="accent-accent-primary"
            />
            Push tags
          </label>

          <div className="flex items-center gap-2">
            {/* Split-button Push */}
            <div className="relative flex" ref={pushMenuRef}>
              <button
                onClick={() => void runPush('normal')}
                disabled={!canPush}
                className="flex items-center gap-1.5 h-8 px-3 rounded-l-md text-[12.5px] font-medium bg-accent-primary hover:bg-accent-secondary text-white transition-colors disabled:opacity-40 disabled:hover:bg-accent-primary"
              >
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                {busy ? 'Pushing…' : 'Push'}
              </button>
              <button
                onClick={() => setPushMenuOpen((v) => !v)}
                disabled={!canPush}
                className="h-8 px-1.5 rounded-r-md bg-accent-primary hover:bg-accent-secondary text-white transition-colors disabled:opacity-40 disabled:hover:bg-accent-primary border-l border-seam-strong"
                aria-label="Push options"
                title="Push options"
              >
                <ChevronDown size={13} />
              </button>
              {pushMenuOpen && (
                <div className="absolute right-0 bottom-full mb-1 z-10 w-[220px] bg-elevation-3 border border-[var(--ij-divider-soft)] rounded-lg overflow-hidden py-1">
                  <button
                    onClick={() => { setPushMenuOpen(false); setForceConfirmOpen(true); }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-text-primary hover:bg-fill-hover transition-colors"
                  >
                    <Zap size={12} className="text-amber-400" />
                    Force Push (with lease)
                  </button>
                </div>
              )}
            </div>

            <Button
              variant="secondary"
              onClick={() => { if (!busy) closePushModal(); }}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </div>
    </Modal>
  );
}
