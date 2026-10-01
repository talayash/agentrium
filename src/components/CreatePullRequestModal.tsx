import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  AlertTriangle, ArrowLeft, CheckCircle2, ExternalLink, GitPullRequestCreate, Info, Loader2, Sparkles, Upload, X,
} from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';
import { usePrStore } from '../store/prStore';
import { toast } from '../store/toastStore';
import { reportInvokeFailure } from '../lib/errorReporter';
import { copyText } from '../lib/clipboard';
import {
  buildPrDraftPrompt, choosePrMethod, defaultPrTitle, formatPrCommits, formatPrFiles, needsPush, prKey,
  prMethodLabel, prSummaryFor, renderPrBody,
  type CompareUrl, type CreatedPullRequest, type PrContext, type PullRequestStatus, type RemoteInfo,
} from '../lib/pullRequests';
import { openPullRequestUrl } from '../lib/pullRequestActions';
import type { PushPreview } from '../types/git';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';

const errText = (err: unknown, fallback: string) => (typeof err === 'string' && err ? err : fallback);
const SUMMARY_PLACEHOLDER = '_Describe what changed and why._';

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export function CreatePullRequestModal() {
  const repoPath = useAppStore((s) => s.createPrRepoPath) || '';
  const terminalId = useAppStore((s) => s.createPrTerminalId);
  const close = useAppStore((s) => s.closeCreatePrModal);
  const prMethodPref = useAppStore((s) => s.prMethod);
  const draftByDefault = useAppStore((s) => s.prDraftByDefault);
  const template = useAppStore((s) => s.prBodyTemplate);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [info, setInfo] = useState<RemoteInfo | null>(null);
  const [preview, setPreview] = useState<PushPreview | null>(null);
  const [baseOptions, setBaseOptions] = useState<string[]>([]);
  const [base, setBase] = useState('');
  const [ctx, setCtx] = useState<PrContext | null>(null);
  const [ctxError, setCtxError] = useState<string | null>(null);
  const [existing, setExisting] = useState<PullRequestStatus | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState(draftByDefault);
  const [busy, setBusy] = useState<null | 'push' | 'create'>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedPullRequest | null>(null);
  // Once the user types, prefill stops overwriting their text.
  const titleTouched = useRef(false);
  const bodyTouched = useRef(false);

  const terminal = useTerminalStore((s) => (terminalId ? s.terminals.get(terminalId) : undefined));
  const task = terminal?.config.task ?? null;
  const method = useMemo(() => choosePrMethod(prMethodPref, info), [prMethodPref, info]);
  const head = preview?.default_remote_branch ?? '';
  const mustPush = preview ? needsPush(preview) : false;

  const loadPreview = useCallback(async () => {
    const p = await invoke<PushPreview>('get_push_preview', { path: repoPath });
    setPreview(p);
    return p;
  }, [repoPath]);

  // Initial load: remote + CLI detection, push state, base candidates.
  useEffect(() => {
    if (!repoPath) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const [remote, p, defaultBranch, refs] = await Promise.all([
          invoke<RemoteInfo>('get_remote_info', { path: repoPath }),
          loadPreview(),
          invoke<string | null>('get_default_branch', { path: repoPath }),
          invoke<string[]>('get_repo_remote_refs', { path: repoPath }),
        ]);
        if (cancelled) return;
        setInfo(remote);
        const prefix = `${remote.remote}/`;
        const branches = refs.filter((r) => r.startsWith(prefix)).map((r) => r.slice(prefix.length));
        const taskBase = task?.baseBranch?.startsWith(prefix) ? task.baseBranch.slice(prefix.length) : task?.baseBranch;
        const initial = taskBase || defaultBranch || 'main';
        const options = [...new Set([initial, ...branches])].filter((b) => b !== p.default_remote_branch);
        setBaseOptions(options);
        setBase(options.includes(initial) ? initial : options[0] ?? initial);
      } catch (err) {
        if (!cancelled) setLoadError(errText(err, 'Could not read the repository remote'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // task is read once for the default base; re-running on every terminal
    // store change would reset the user's base choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath, loadPreview]);

  // Is there already a PR for this head? Only a signed-in CLI can say.
  useEffect(() => {
    if (!info?.cli || !preview) return;
    let cancelled = false;
    invoke<PullRequestStatus | null>('get_pull_request_status', { path: repoPath, branch: preview.default_remote_branch })
      .then((s) => { if (!cancelled && s && s.state === 'open') setExisting(s); })
      .catch(() => {
        // Optional hint only: creating still works, and the backend answers
        // "already exists" with the existing PR's URL.
      });
    return () => { cancelled = true; };
  }, [info?.cli, preview, repoPath]);

  // Commits + files for the chosen base, then prefill title and body.
  useEffect(() => {
    if (!base || !repoPath) return;
    let cancelled = false;
    setCtxError(null);
    invoke<PrContext>('get_pr_context', { path: repoPath, base })
      .then((c) => { if (!cancelled) setCtx(c); })
      .catch((err) => {
        // Shown inline next to the base picker; the user can pick another base.
        if (!cancelled) { setCtx(null); setCtxError(errText(err, 'Could not compare with this base')); }
      });
    return () => { cancelled = true; };
  }, [base, repoPath]);

  useEffect(() => {
    if (!ctx) return;
    const nextTitle = titleTouched.current ? title : defaultPrTitle(task, ctx.commits);
    if (!titleTouched.current) setTitle(nextTitle);
    if (!bodyTouched.current) {
      setBody(renderPrBody(template, {
        title: nextTitle,
        summary: prSummaryFor(terminal) || SUMMARY_PLACEHOLDER,
        files: formatPrFiles(ctx.files),
        commits: formatPrCommits(ctx.commits),
      }));
    }
    // Prefill reacts to a new comparison only, not to every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx]);

  const trackPr = useCallback((pr: { url: string; number: number; provider: CreatedPullRequest['provider'] }, fresh: boolean) => {
    const git = terminalId ? useTerminalStore.getState().gitInfoCache.get(terminalId) : undefined;
    const branch = git?.current_branch ?? preview?.local_branch;
    if (!branch) return;
    const key = prKey(git?.worktree_root ?? repoPath, branch);
    // Copy only the ref fields: callers pass whole CLI results, and extras
    // would be persisted with the ref.
    const ref = { url: pr.url, number: pr.number, provider: pr.provider };
    // A PR we just opened starts from a known baseline so its first CI
    // failure raises an attention item; one found elsewhere is a baseline.
    usePrStore.getState().setRef(key, fresh ? { ...ref, lastState: 'open', lastCi: 'none' } : ref);
  }, [terminalId, preview?.local_branch, repoPath]);

  useEffect(() => {
    if (existing) trackPr(existing, false);
  }, [existing, trackPr]);

  const refreshGitInfo = useCallback(() => {
    const { terminals, fetchGitInfo } = useTerminalStore.getState();
    for (const t of terminals.values()) if (t.config.working_directory === repoPath) void fetchGitInfo(t.config.id);
  }, [repoPath]);

  const pushFirst = useCallback(async () => {
    if (!preview) return;
    setBusy('push');
    setActionError(null);
    try {
      await invoke('git_push', {
        path: repoPath, remote: preview.default_remote, remoteBranch: preview.default_remote_branch,
        mode: 'normal', pushTags: false, setUpstream: !preview.has_upstream,
      });
      toast.success('Push', `Pushed to ${preview.default_remote}/${preview.default_remote_branch}`);
      refreshGitInfo();
      await loadPreview();
    } catch (err) {
      const msg = errText(err, 'Push failed');
      setActionError(msg);
      toast.error('Push failed', msg);
      reportInvokeFailure('git_push', err);
    } finally {
      setBusy(null);
    }
  }, [preview, repoPath, refreshGitInfo, loadPreview]);

  const submit = useCallback(async () => {
    if (!preview || !base || !title.trim()) return;
    setBusy('create');
    setActionError(null);
    const args = { path: repoPath, base, head: preview.default_remote_branch, title: title.trim(), body };
    try {
      if (method.kind === 'cli') {
        const pr = await invoke<CreatedPullRequest>('create_pull_request', { ...args, draft });
        trackPr(pr, !pr.already_existed);
        setCreated(pr);
        if (pr.already_existed) toast.info('Pull request already exists', `#${pr.number} is open for this branch.`);
        else toast.success('Pull request created', `#${pr.number} ${title.trim()}`);
      } else {
        const compare = await invoke<CompareUrl>('build_pr_compare_url', args);
        const copied = body.trim() ? await copyText(body) : false;
        await invoke('open_external_url', { url: compare.url });
        const note = compare.body === 'full' ? ''
          : compare.body === 'truncated' ? ' The description was shortened in the link.'
          : ' This host takes no description in the link.';
        toast.info('Opened in your browser', `Finish the pull request there.${note}${copied ? ' The full description is on your clipboard.' : ''}`);
        close();
      }
    } catch (err) {
      const msg = errText(err, 'Could not create the pull request');
      setActionError(msg);
      toast.error('Create pull request failed', msg);
      reportInvokeFailure(method.kind === 'cli' ? 'create_pull_request' : 'build_pr_compare_url', err);
    } finally {
      setBusy(null);
    }
  }, [preview, base, title, body, draft, repoPath, method, trackPr, close]);

  const generateWithAgent = useCallback(() => {
    if (!terminalId) return;
    const prompt = buildPrDraftPrompt(base, head, ctx);
    const app = useAppStore.getState();
    app.setPromptDraft(terminalId, prompt);
    useTerminalStore.getState().setActiveTerminal(terminalId);
    close();
    app.openPromptEditor(terminalId, prompt);
    toast.info('Prompt staged', 'Review it in the prompt editor and send it when you are ready. Reopen Create pull request to paste the result.');
  }, [terminalId, base, head, ctx, close]);

  const handleClose = useCallback(() => { if (!busy) close(); }, [busy, close]);
  const canCreate = !!preview && !!base && !!title.trim() && !mustPush && !busy && !ctxError;

  return (
    <Modal onClose={handleClose} closeOn="click" panelClassName="w-[92vw] max-w-[840px] h-[80vh] max-h-[720px] grid grid-rows-[44px_40px_1fr_auto_56px]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 bg-elevation-1 border-b border-seam">
        <span className="text-text-primary text-[13px] font-semibold truncate">
          Create Pull Request{info ? ` on ${info.owner}/${info.repo}` : ` for ${basename(repoPath) || 'repository'}`}
        </span>
        <button onClick={handleClose} disabled={!!busy} title="Close (Esc)" aria-label="Close"
          className="p-1.5 rounded hover:bg-fill-hover text-text-tertiary transition-colors disabled:opacity-40">
          <X size={14} />
        </button>
      </div>

      {/* Branch route strip: base <- head */}
      <div className="flex items-center gap-2 px-3 bg-accent-primary/15 border-b border-seam text-[12.5px]">
        {preview && !loadError ? (
          <>
            <label className="sr-only" htmlFor="pr-base">Base branch</label>
            <select id="pr-base" value={base} onChange={(e) => setBase(e.target.value)} disabled={!!busy || !!created}
              className="font-mono text-text-primary bg-elevation-0 border border-seam rounded-md h-6 px-1.5 text-[12px] focus:outline-none focus:border-accent-primary disabled:opacity-50 max-w-[260px]">
              {baseOptions.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
            <ArrowLeft size={12} className="text-text-tertiary flex-shrink-0" />
            <span className="font-mono text-accent-primary truncate max-w-[300px]" title={head}>{head}</span>
            {info && <span className="ml-auto text-[11px] text-text-tertiary truncate">{info.remote} · {info.host}</span>}
          </>
        ) : (
          <span className="text-text-tertiary">{loading ? 'Loading…' : ''}</span>
        )}
      </div>

      {/* Body */}
      <div className="overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center h-full text-text-tertiary text-[12px]">
            <Loader2 size={14} className="animate-spin mr-2" /> Reading the repository…
          </div>
        )}

        {!loading && loadError && (
          <div className="flex flex-col items-center justify-center h-full px-6 text-center gap-3">
            <AlertTriangle size={24} className="text-error" />
            <div className="text-text-primary text-[13px] font-medium">Can't create a pull request</div>
            <div className="text-text-tertiary text-[12px] max-w-[440px]">{loadError}</div>
          </div>
        )}

        {!loading && !loadError && created && (
          <div className="flex flex-col items-center justify-center h-full px-6 text-center gap-3">
            <CheckCircle2 size={28} className="text-emerald-400" />
            <div className="text-text-primary text-[13px] font-medium">
              {created.already_existed ? `Pull request #${created.number} already exists` : `Pull request #${created.number} created`}
            </div>
            <div className="text-text-tertiary text-[12px] max-w-[440px] break-all">{created.url}</div>
            <div className="text-text-tertiary text-[11.5px]">Its status now shows on this session's tab.</div>
            <Button variant="primary" size="sm" icon={<ExternalLink size={12} />} onClick={() => openPullRequestUrl(created.url)}>
              Open pull request
            </Button>
          </div>
        )}

        {!loading && !loadError && !created && preview && (
          <div className="p-3 space-y-3">
            {mustPush && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-amber-500/10 border border-amber-500/30 text-[12px] text-amber-200">
                <Upload size={13} className="flex-shrink-0" />
                <span className="flex-1">
                  {preview.has_upstream
                    ? `${preview.ahead} commit${preview.ahead === 1 ? '' : 's'} not pushed yet.`
                    : 'This branch is not on the remote yet.'}{' '}
                  Push <span className="font-mono">{preview.local_branch}</span> to{' '}
                  <span className="font-mono">{preview.default_remote}/{preview.default_remote_branch}</span> first.
                </span>
                <Button variant="secondary" size="sm" loading={busy === 'push'} disabled={!!busy} onClick={() => void pushFirst()}>
                  Push
                </Button>
              </div>
            )}

            {existing && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-sky-500/10 border border-sky-500/30 text-[12px] text-sky-200">
                <Info size={13} className="flex-shrink-0" />
                <span className="flex-1">Pull request #{existing.number} is already open for this branch. Its status now shows on the tab.</span>
                <Button variant="secondary" size="sm" icon={<ExternalLink size={12} />} onClick={() => openPullRequestUrl(existing.url)}>Open</Button>
              </div>
            )}

            {method.kind === 'browser' && method.reason && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-sky-500/10 border border-sky-500/30 text-[12px] text-sky-200">
                <Info size={13} className="mt-0.5 flex-shrink-0" />
                <span>{method.reason} The pull request will open in your browser instead.</span>
              </div>
            )}

            {ctxError && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-red-500/10 border border-red-500/30 text-[12px] text-red-300">
                <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />
                <span>{ctxError}</span>
              </div>
            )}

            <div className="space-y-1">
              <label htmlFor="pr-title" className="text-[11px] uppercase tracking-wider font-semibold text-text-tertiary">Title</label>
              <input id="pr-title" value={title} disabled={!!busy} spellCheck
                onChange={(e) => { titleTouched.current = true; setTitle(e.target.value); }}
                placeholder="Summarize the change"
                className="w-full bg-elevation-0 border border-seam rounded-md h-8 px-2 text-[13px] text-text-primary focus:outline-none focus:border-accent-primary disabled:opacity-50" />
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label htmlFor="pr-body" className="text-[11px] uppercase tracking-wider font-semibold text-text-tertiary">Description</label>
                {terminalId && (
                  <Button variant="ghost" size="sm" icon={<Sparkles size={12} />} disabled={!!busy} onClick={generateWithAgent}
                    title="Stage a prompt in this session's prompt editor asking the agent to draft the title and description. Nothing is sent automatically.">
                    Generate with agent
                  </Button>
                )}
              </div>
              <textarea id="pr-body" value={body} disabled={!!busy} rows={14}
                onChange={(e) => { bodyTouched.current = true; setBody(e.target.value); }}
                className="w-full bg-elevation-0 border border-seam rounded-md p-2 text-[12px] font-mono text-text-primary leading-relaxed resize-y focus:outline-none focus:border-accent-primary disabled:opacity-50" />
              {ctx && (
                <div className="text-[11px] text-text-tertiary">
                  {ctx.commits.length} commit{ctx.commits.length === 1 ? '' : 's'} and {ctx.files.length} file{ctx.files.length === 1 ? '' : 's'} compared with <span className="font-mono">{ctx.base_ref}</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Inline action error */}
      {actionError ? (
        <div className="flex items-start gap-2 px-3 py-2 bg-red-500/10 border-t border-red-500/30 text-[12px] text-red-300">
          <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />
          <span className="flex-1 break-words">{actionError}</span>
          <button onClick={() => setActionError(null)} aria-label="Dismiss error" className="opacity-70 hover:opacity-100"><X size={12} /></button>
        </div>
      ) : <div />}

      {/* Footer */}
      <div className="flex items-center justify-between px-3 bg-elevation-1 border-t border-seam">
        <div className="flex items-center gap-3">
          {!created && (
            <label className={`flex items-center gap-2 text-[12px] text-text-secondary select-none ${method.kind === 'cli' ? 'cursor-pointer' : 'opacity-50'}`}
              title={method.kind === 'cli' ? undefined : 'Choose draft on the create page in your browser'}>
              <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)}
                disabled={!!busy || method.kind !== 'cli'} className="accent-accent-primary" />
              Draft
            </label>
          )}
          {!loading && !loadError && !created && (
            <span className="text-[11px] text-text-tertiary" data-testid="pr-method">{prMethodLabel(method)}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!created && !loadError && (
            <Button variant="primary" loading={busy === 'create'} disabled={!canCreate} onClick={() => void submit()}
              icon={method.kind === 'cli' ? <GitPullRequestCreate size={14} /> : <ExternalLink size={14} />}>
              {method.kind === 'cli' ? 'Create Pull Request' : 'Open in Browser'}
            </Button>
          )}
          <Button variant="secondary" onClick={handleClose} disabled={!!busy}>{created ? 'Close' : 'Cancel'}</Button>
        </div>
      </div>
    </Modal>
  );
}
