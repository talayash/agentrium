import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../../../store/appStore';
import { toast } from '../../../store/toastStore';
import { reportInvokeFailure } from '../../../lib/errorReporter';
import { confirmAction } from '../../../lib/confirmDialog';
import {
  DEFAULT_SETUP_FILES, finishTask, knownRepoPaths, setupFilesFor, type ManagedTaskWorktree,
} from '../../../lib/tasks';
import { PageHeader, PageSection, SettingRow, Segmented, Toggle } from '../SettingRow';
import { DEFAULT_PR_BODY_TEMPLATE } from '../../../lib/pullRequests';
import { registerSetting } from '../index';

const cat = { group: 'vcs', page: 'git' } as const;
['commit-template', 'auto-stage', 'merge-strategy'].forEach((id) =>
  registerSetting({ category: cat, id, label: id.replace(/-/g, ' '), keywords: ['git', 'commit', 'merge'] })
);
['pr-method', 'pr-draft-default', 'pr-body-template'].forEach((id) =>
  registerSetting({ category: cat, id, label: id.replace(/-/g, ' '), keywords: ['git', 'pull request', 'pr', 'gh', 'glab', 'merge request'] })
);
['task-isolation', 'task-worktree-folder', 'task-setup-files', 'task-orphaned-worktrees'].forEach((id) =>
  registerSetting({ category: cat, id, label: id.replace(/-/g, ' '), keywords: ['git', 'task', 'worktree', 'isolation'] })
);

const FIELD = 'w-72 bg-elevation-0 text-text-primary text-[12px] px-2 py-1 rounded ring-1 ring-border-light font-mono';

export default function GitPage() {
  const vcsCommitMessageTemplate = useAppStore((s) => s.vcsCommitMessageTemplate);
  const vcsDefaultAutoStage = useAppStore((s) => s.vcsDefaultAutoStage);
  const vcsDefaultMergeStrategy = useAppStore((s) => s.vcsDefaultMergeStrategy);
  const newTerminalIsolation = useAppStore((s) => s.newTerminalIsolation);
  const taskWorktreeRoot = useAppStore((s) => s.taskWorktreeRoot);
  const taskSetupFiles = useAppStore((s) => s.taskSetupFiles);
  const prMethod = useAppStore((s) => s.prMethod);
  const prDraftByDefault = useAppStore((s) => s.prDraftByDefault);
  const prBodyTemplate = useAppStore((s) => s.prBodyTemplate);
  const {
    setVcsCommitMessageTemplate, setVcsDefaultAutoStage, setVcsDefaultMergeStrategy,
    setNewTerminalIsolation, setTaskWorktreeRoot, setTaskSetupFiles,
    setPrMethod, setPrDraftByDefault, setPrBodyTemplate,
  } = useAppStore.getState();

  return (
    <div>
      <PageHeader title="Version Control - Git" />

      <PageSection title="Commits">
        <SettingRow
          label="Commit message template"
          description="Pre-fills the commit textarea. Supports {branch} and {date} placeholders."
          align="start"
        >
          <textarea
            rows={3}
            value={vcsCommitMessageTemplate}
            onChange={(e) => setVcsCommitMessageTemplate(e.target.value)}
            placeholder="e.g. [{branch}] "
            className="w-72 bg-elevation-0 text-text-primary text-[12px] px-2 py-1 rounded ring-1 ring-border-light font-mono resize-y"
          />
        </SettingRow>
        <SettingRow label="Default auto-stage">
          <Segmented
            value={vcsDefaultAutoStage}
            onChange={setVcsDefaultAutoStage}
            options={[
              { value: 'none',    label: 'None' },
              { value: 'tracked', label: 'Tracked' },
              { value: 'all',     label: 'All' },
            ]}
          />
        </SettingRow>
      </PageSection>

      <PageSection title="Pull / Merge">
        <SettingRow
          label="Default merge strategy"
          description="Also picks the Finish task default: FF only uses fast-forward when possible, others squash."
        >
          <Segmented
            value={vcsDefaultMergeStrategy}
            onChange={setVcsDefaultMergeStrategy}
            options={[
              { value: 'merge',   label: 'Merge' },
              { value: 'rebase',  label: 'Rebase' },
              { value: 'ff-only', label: 'FF only' },
            ]}
          />
        </SettingRow>
      </PageSection>

      <PageSection title="Pull requests">
        <SettingRow
          label="Create pull requests"
          description="Auto uses a signed-in gh (GitHub) or glab (GitLab) CLI and otherwise opens the create page in your browser. Agentrium never stores a token."
        >
          <Segmented
            value={prMethod}
            onChange={setPrMethod}
            options={[
              { value: 'auto',    label: 'Auto' },
              { value: 'gh',      label: 'gh / glab CLI' },
              { value: 'browser', label: 'Browser' },
            ]}
          />
        </SettingRow>
        <SettingRow label="Create as draft by default" description="Draft applies when the CLI creates the PR.">
          <Toggle value={prDraftByDefault} onChange={setPrDraftByDefault} label="Create as draft by default" />
        </SettingRow>
        <SettingRow
          label="Description template"
          description="Prefills the PR description. Supports {title}, {summary}, {files} and {commits}."
          align="start"
        >
          <div className="flex flex-col gap-1.5 w-72">
            <textarea
              rows={6}
              value={prBodyTemplate}
              onChange={(e) => setPrBodyTemplate(e.target.value)}
              aria-label="Pull request description template"
              className="bg-elevation-0 text-text-primary text-[12px] px-2 py-1 rounded ring-1 ring-border-light font-mono resize-y"
            />
            {prBodyTemplate !== DEFAULT_PR_BODY_TEMPLATE && (
              <button type="button" onClick={() => setPrBodyTemplate(DEFAULT_PR_BODY_TEMPLATE)} className="self-start text-[11.5px] text-accent-primary hover:underline">
                Reset to default
              </button>
            )}
          </div>
        </SettingRow>
      </PageSection>

      <PageSection title="Tasks and worktrees">
        <SettingRow
          label="New terminals in a git repo"
          description="Ask shows a worktree toggle in New Session. Always turns it on by default."
        >
          <Segmented
            value={newTerminalIsolation}
            onChange={setNewTerminalIsolation}
            options={[
              { value: 'ask',    label: 'Ask' },
              { value: 'always', label: 'Always create a worktree' },
              { value: 'never',  label: 'Never' },
            ]}
          />
        </SettingRow>
        <SettingRow
          label="Task worktree folder"
          description="Empty uses <repo-parent>/.agentrium-worktrees. Each repo gets its own subfolder."
        >
          <input
            value={taskWorktreeRoot}
            onChange={(e) => setTaskWorktreeRoot(e.target.value)}
            placeholder="<repo-parent>/.agentrium-worktrees"
            aria-label="Task worktree folder"
            className={FIELD}
          />
        </SettingRow>
        <SetupFilesRow perRepo={taskSetupFiles} onChange={setTaskSetupFiles} />
        <OrphanedWorktrees />
      </PageSection>
    </div>
  );
}

function SetupFilesRow({ perRepo, onChange }: {
  perRepo: Record<string, string[]>;
  onChange: (repo: string, files: string[] | null) => void;
}) {
  const repos = useMemo(() => [...new Set([...knownRepoPaths(), ...Object.keys(perRepo)])], [perRepo]);
  const [repo, setRepo] = useState(repos[0] ?? '');
  const files = repo ? setupFilesFor(repo, perRepo) : DEFAULT_SETUP_FILES;
  const [draft, setDraft] = useState(files.join(', '));
  // Reset the draft only when switching repos, not on every keystroke save.
  useEffect(() => { setDraft(files.join(', ')); }, [repo]);

  const commit = () => {
    if (!repo) return;
    const list = draft.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    onChange(repo, list);
  };

  return (
    <SettingRow
      label="Setup files copied into new task worktrees"
      description="Gitignored files only, as repo-relative paths (no globs). Default: .env, .env.local."
      align="start"
    >
      <div className="flex flex-col gap-1.5 w-72">
        {repos.length === 0 ? (
          <p className="text-[11.5px] text-text-tertiary">Open a session in a repository to customize its list.</p>
        ) : (
          <>
            <select value={repo} onChange={(e) => setRepo(e.target.value)} aria-label="Repository"
              className="bg-elevation-0 text-text-primary text-[12px] px-2 py-1 rounded ring-1 ring-border-light">
              {repos.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <input value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
              onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
              aria-label="Setup files" className={FIELD.replace('w-72 ', '')} />
            {perRepo[repo] && (
              <button type="button" onClick={() => onChange(repo, null)} className="self-start text-[11.5px] text-accent-primary hover:underline">
                Reset to default
              </button>
            )}
          </>
        )}
      </div>
    </SettingRow>
  );
}

function OrphanedWorktrees() {
  const [items, setItems] = useState<ManagedTaskWorktree[] | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);

  const load = useCallback(() => {
    invoke<ManagedTaskWorktree[]>('list_task_worktrees')
      .then(setItems)
      .catch((err) => {
        setItems([]);
        reportInvokeFailure('list_task_worktrees', err);
      });
  }, []);
  useEffect(load, [load]);

  const orphans = (items ?? []).filter((w) => w.orphaned);

  const remove = async (w: ManagedTaskWorktree, deleteBranch: boolean) => {
    if (deleteBranch) {
      const ok = await confirmAction(
        `Delete the worktree and branch ${w.task.branch}? Commits that are not merged into ${w.task.baseBranch} will be lost.`,
        { okLabel: 'Delete' },
      );
      if (!ok) return;
    }
    setBusyPath(w.task.worktreePath);
    try {
      await finishTask(w.task.worktreePath, deleteBranch ? { kind: 'discard', confirm_unmerged: true } : { kind: 'keep' });
      toast.success('Worktree removed', deleteBranch ? `${w.task.branch} was deleted.` : `Branch ${w.task.branch} was kept.`);
    } catch (err) {
      toast.error('Could not remove the worktree', String(err));
      reportInvokeFailure('finish_task', err);
    } finally {
      setBusyPath(null);
      load();
    }
  };

  return (
    <SettingRow
      label="Orphaned task worktrees"
      description="Task worktrees with no open session."
      align="start"
    >
      <div className="w-72 flex flex-col gap-1.5">
        {items === null && <p className="text-[11.5px] text-text-tertiary">Loading...</p>}
        {items !== null && orphans.length === 0 && <p className="text-[11.5px] text-text-tertiary">None.</p>}
        {orphans.map((w) => (
          <div key={w.task.worktreePath} className="rounded-md ring-1 ring-seam p-2 flex flex-col gap-1">
            <span className="text-[12px] text-text-primary truncate" title={w.task.title}>{w.task.title}</span>
            <span className="text-[11px] font-mono text-text-tertiary truncate" title={w.task.worktreePath}>
              {w.task.branch}{w.exists ? '' : ' (folder missing)'}
            </span>
            <div className="flex gap-2">
              <button type="button" disabled={busyPath !== null} onClick={() => void remove(w, false)}
                className="text-[11.5px] text-accent-primary hover:underline disabled:opacity-50">
                Remove worktree
              </button>
              <button type="button" disabled={busyPath !== null} onClick={() => void remove(w, true)}
                className="text-[11.5px] text-error hover:underline disabled:opacity-50">
                Remove and delete branch
              </button>
            </div>
          </div>
        ))}
      </div>
    </SettingRow>
  );
}
