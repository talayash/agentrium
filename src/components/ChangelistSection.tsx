// IntelliJ-style commit Changes tree.
// Mirrors the IntelliJ commit tool window structure 1:1:
//   Changes            <- tracked files in the implicit Default changelist
//   <named changelist> <- tracked files assigned to user changelists
//   Unversioned Files  <- ALL untracked files, always their own group
// with IntelliJ checkbox semantics:
//   checked       = file is staged (included in the commit)
//   unchecked     = file is unstaged
//   indeterminate = partially staged (both staged and unstaged hunks)
// Toggling a checkbox stages/unstages the file; group checkboxes act on the
// whole group. Files named after Windows reserved devices (nul, con, ...)
// cannot be indexed by git - their checkbox is disabled and group toggles
// skip them.
//
// Backed by 6 Tauri commands in src-tauri/src/commands.rs:
//   list_changelists, create_changelist, rename_changelist, delete_changelist,
//   assign_files_to_changelist, get_changelist_assignments.
//
// "Default" is implicit (rendered as "Changes"). Mappings persist across
// commits (sticky).

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Plus, ChevronRight, ChevronDown, MoreVertical, Edit3, Trash2, Check,
  FileEdit, Loader2,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store/appStore';
import { toast } from '../store/toastStore';
import { getFileIconUrl } from '../utils/fileIcons';
import { InlineDiffView } from './InlineDiffView';

export interface MergedChange {
  path: string;
  status: string;
  /** Fully staged - no unstaged counterpart. */
  staged: boolean;
  /** Appears both staged and unstaged (partially staged). */
  partial: boolean;
}

interface ChangelistInfo {
  id: number | null;
  name: string;
  is_default: boolean;
}

interface Props {
  repoPath: string;
  files: MergedChange[];
  branch: string | null;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  stagingPaths: Set<string>;
  refreshTrigger: number;
  expandedFile: string | null;
  setExpandedFile: (v: string | null) => void;
  terminalId: string | null;
  pathOverride: string | null;
}

// IntelliJ conveys git status via filename color: new = green, modified = blue,
// deleted = gray strikethrough, untracked = red.
const statusConfig: Record<string, { color: string }> = {
  new:       { color: 'text-green-400' },
  modified:  { color: 'text-blue-400' },
  deleted:   { color: 'text-text-tertiary line-through' },
  renamed:   { color: 'text-cyan-400' },
  untracked: { color: 'text-red-400' },
};

function pathBasename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

function joinRepoPath(root: string, relative: string): string {
  const cleanRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const cleanRel = relative.replace(/\\/g, '/').replace(/^\/+/, '');
  const unquotedRel = cleanRel.startsWith('"') && cleanRel.endsWith('"')
    ? cleanRel.slice(1, -1)
    : cleanRel;
  return `${cleanRoot}/${unquotedRel}`;
}

// IntelliJ shows the file's directory as a dim path after the name: the
// repo-relative directory for nested files, or the repo folder name for files
// at the root (e.g. ".env.local  wg-client").
function displayLocation(repoRoot: string, relPath: string): string {
  const idx = Math.max(relPath.lastIndexOf('/'), relPath.lastIndexOf('\\'));
  if (idx === -1) return pathBasename(repoRoot);
  return relPath.slice(0, idx).replace(/\//g, '\\');
}

// Files named after Windows device names cannot be read by git - reads hit
// the device instead of the file. Mirrors is_windows_reserved_name in
// src-tauri/src/commands.rs.
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);
function isWindowsReservedName(path: string): boolean {
  const base = pathBasename(path);
  const stem = base.split('.')[0] ?? base;
  return RESERVED_NAMES.has(stem.toLowerCase());
}
const RESERVED_HINT = 'Windows reserved device name - git cannot index this file. Delete it or add it to .gitignore.';

// Native checkbox that supports the indeterminate visual state.
function TriCheckbox({
  checked, indeterminate, busy, disabled, onToggle, label, title,
}: {
  checked: boolean;
  indeterminate?: boolean;
  busy?: boolean;
  disabled?: boolean;
  onToggle: () => void;
  label: string;
  title?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate && !checked;
  }, [indeterminate, checked]);
  if (busy) {
    return <Loader2 size={12} className="animate-spin text-text-tertiary shrink-0 w-[13px]" />;
  }
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onClick={(e) => e.stopPropagation()}
      onChange={onToggle}
      aria-label={label}
      title={title}
      className="accent-accent-primary w-[13px] h-[13px] shrink-0 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
    />
  );
}

type GroupKind = 'default' | 'named' | 'unversioned';

export function ChangelistSection({
  repoPath, files, branch, onStage, onUnstage, stagingPaths, refreshTrigger,
  expandedFile, setExpandedFile, terminalId, pathOverride,
}: Props) {
  const confirmDelete = useAppStore((s) => s.vcsChangelistsConfirmDelete);
  const triggerChangesRefresh = useAppStore((s) => s.triggerChangesRefresh);
  const openDiffTab = useAppStore((s) => s.openDiffTab);
  const closeFileTab = useAppStore((s) => s.closeFileTab);

  const onDiscard = useCallback(async (file: MergedChange) => {
    const label = pathBasename(file.path);
    const verb = file.status === 'untracked' ? 'Delete' : 'Discard';
    const ok = window.confirm(`${verb}: ${label}? This cannot be undone.`);
    if (!ok) return;
    try {
      await invoke('git_discard_file', {
        path: repoPath, file: file.path,
        untracked: file.status === 'untracked',
      });
      // If the file was open in the editor, close it - its contents no longer match disk.
      closeFileTab(joinRepoPath(repoPath, file.path));
      toast.success(`${verb}ed`, label);
      triggerChangesRefresh();
    } catch (err) {
      toast.error(`${verb} failed`, typeof err === 'string' ? err : 'Unknown error');
    }
  }, [repoPath, triggerChangesRefresh, closeFileTab]);

  const [lists, setLists] = useState<ChangelistInfo[]>([{ id: null, name: 'Default', is_default: true }]);
  const [assignments, setAssignments] = useState<Map<string, number>>(new Map());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');
  const [menuListId, setMenuListId] = useState<number | null>(null);
  const [contextFile, setContextFile] = useState<{ file: MergedChange; x: number; y: number } | null>(null);

  const fetch = useCallback(async () => {
    if (!repoPath) { setLists([{ id: null, name: 'Default', is_default: true }]); setAssignments(new Map()); return; }
    try {
      const [ls, as_] = await Promise.all([
        invoke<ChangelistInfo[]>('list_changelists', { repoPath }),
        invoke<[string, number][]>('get_changelist_assignments', { repoPath }),
      ]);
      setLists(ls);
      setAssignments(new Map(as_));
    } catch (err) {
      setLists([{ id: null, name: 'Default', is_default: true }]);
      setAssignments(new Map());
      console.warn('Changelists fetch failed:', err);
    }
  }, [repoPath]);

  useEffect(() => { fetch(); }, [fetch, refreshTrigger]);

  const byBasename = (a: MergedChange, b: MergedChange) =>
    pathBasename(a.path).localeCompare(pathBasename(b.path));

  // Tracked files group by changelist; untracked always live in their own
  // "Unversioned Files" group, like IntelliJ.
  const { grouped, unversioned } = useMemo(() => {
    const grouped = new Map<number | 'default', MergedChange[]>();
    grouped.set('default', []);
    for (const list of lists) if (list.id != null) grouped.set(list.id, []);
    const unversioned: MergedChange[] = [];
    for (const f of files) {
      if (f.status === 'untracked') { unversioned.push(f); continue; }
      const assigned = assignments.get(f.path);
      if (assigned != null && grouped.has(assigned)) grouped.get(assigned)!.push(f);
      else grouped.get('default')!.push(f);
    }
    for (const arr of grouped.values()) arr.sort(byBasename);
    unversioned.sort(byBasename);
    return { grouped, unversioned };
  }, [lists, files, assignments]);

  const handleCreate = useCallback(async () => {
    const name = newName.trim();
    if (!name) { setCreating(false); return; }
    try {
      await invoke('create_changelist', { repoPath, name });
      toast.success('Changelist created', name);
      setNewName(''); setCreating(false);
      await fetch();
    } catch (err) {
      toast.error('Create failed', typeof err === 'string' ? err : 'Unknown error');
    }
  }, [newName, repoPath, fetch]);

  const handleRename = useCallback(async (id: number) => {
    const name = editingName.trim();
    if (!name) { setEditingId(null); return; }
    try {
      await invoke('rename_changelist', { id, newName: name });
      toast.success('Renamed', name);
      setEditingId(null);
      await fetch();
    } catch (err) {
      toast.error('Rename failed', typeof err === 'string' ? err : 'Unknown error');
    }
  }, [editingName, fetch]);

  const handleDelete = useCallback(async (id: number, name: string) => {
    if (confirmDelete) {
      const ok = window.confirm(`Delete changelist "${name}"? Its files revert to Changes.`);
      if (!ok) return;
    }
    try {
      await invoke('delete_changelist', { id });
      toast.success('Deleted', name);
      await fetch();
    } catch (err) {
      toast.error('Delete failed', typeof err === 'string' ? err : 'Unknown error');
    }
  }, [confirmDelete, fetch]);

  const moveFile = useCallback(async (filePath: string, targetId: number | null) => {
    try {
      await invoke('assign_files_to_changelist', {
        repoPath, filePaths: [filePath], changelistId: targetId,
      });
      await fetch();
    } catch (err) {
      toast.error('Move failed', typeof err === 'string' ? err : 'Unknown error');
    }
  }, [repoPath, fetch]);

  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setMenuListId(null);
        setContextFile(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const toggleFile = useCallback((file: MergedChange) => {
    if (file.staged) onUnstage([file.path]);
    else onStage([file.path]);
  }, [onStage, onUnstage]);

  const renderRow = (file: MergedChange) => {
    const config = statusConfig[file.status] || statusConfig.untracked;
    const isBusy = stagingPaths.has(`stage:${file.path}`) || stagingPaths.has(`unstage:${file.path}`);
    const isSelected = expandedFile === file.path;
    const reserved = isWindowsReservedName(file.path);
    return (
      <div key={file.path}>
        <div
          onClick={() => setExpandedFile(isSelected ? null : file.path)}
          onContextMenu={(e) => {
            e.preventDefault();
            if (file.status !== 'untracked') {
              setContextFile({ file, x: e.clientX, y: e.clientY });
            }
          }}
          title={reserved ? RESERVED_HINT : undefined}
          className={`group flex items-center gap-1.5 pl-7 pr-2 py-[3px] cursor-pointer transition-colors ${
            isSelected ? 'bg-accent-primary' : 'hover:bg-fill-hover'
          }`}
        >
          <TriCheckbox
            checked={file.staged}
            indeterminate={file.partial}
            busy={isBusy}
            disabled={reserved}
            onToggle={() => toggleFile(file)}
            label={`Include ${file.path} in commit`}
            title={reserved ? RESERVED_HINT : undefined}
          />
          <img
            src={getFileIconUrl(pathBasename(file.path))}
            alt="" aria-hidden draggable={false}
            className="w-[14px] h-[14px] shrink-0 select-none"
          />
          <span
            className={`text-[12px] truncate shrink-0 max-w-[55%] ${isSelected ? 'text-white' : config.color}`}
            title={file.path}
          >
            {pathBasename(file.path)}
          </span>
          <span
            className={`flex-1 text-[11px] truncate ${isSelected ? 'text-white/70' : 'text-text-tertiary'}`}
            title={file.path}
          >
            {displayLocation(repoPath, file.path)}
          </span>
          {file.status !== 'deleted' && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                void openDiffTab(joinRepoPath(repoPath, file.path), repoPath, file.path);
              }}
              className={`shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-fill-active ${
                isSelected ? 'text-white/80 hover:text-white' : 'text-text-tertiary hover:text-text-primary'
              }`}
              title="Open diff in editor"
            >
              <FileEdit size={11} />
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onDiscard(file); }}
            className={`shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500/20 hover:text-red-400 ${
              isSelected ? 'text-white/80' : 'text-text-tertiary'
            }`}
            title={file.status === 'untracked' ? 'Delete untracked file' : 'Discard all changes'}
          >
            <Trash2 size={11} />
          </button>
        </div>
        {isSelected && terminalId && (
          <div className="ml-7 mr-1 my-1 rounded overflow-hidden border border-border/30">
            <InlineDiffView filePath={file.path} terminalId={terminalId} pathOverride={pathOverride} />
          </div>
        )}
      </div>
    );
  };

  const renderGroup = (headerName: string, kind: GroupKind, groupFiles: MergedChange[], listId: number | null) => {
    const isCollapsed = collapsed.has(headerName);
    const isMenuOpen = menuListId === listId;
    // Reserved-name files cannot be staged - exclude them from the group
    // checkbox so "check all" never produces an error toast.
    const stageables = groupFiles.filter((f) => !isWindowsReservedName(f.path));
    const stagedCount = stageables.filter((f) => f.staged).length;
    const partialCount = stageables.filter((f) => f.partial).length;
    const allChecked = stageables.length > 0 && stagedCount === stageables.length;
    const someChecked = stagedCount > 0 || partialCount > 0;
    return (
      <div key={`${kind}:${headerName}:${listId ?? ''}`}>
        <div className="group flex items-center gap-1 px-1.5 py-[3px] hover:bg-fill-hover">
          <button
            onClick={() => {
              const next = new Set(collapsed);
              if (next.has(headerName)) next.delete(headerName); else next.add(headerName);
              setCollapsed(next);
            }}
            className="shrink-0 text-text-tertiary hover:text-text-primary"
            aria-label={isCollapsed ? `Expand ${headerName}` : `Collapse ${headerName}`}
          >
            {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          </button>
          <TriCheckbox
            checked={allChecked}
            indeterminate={!allChecked && someChecked}
            onToggle={() => {
              if (allChecked) onUnstage(stageables.map((f) => f.path));
              else onStage(stageables.filter((f) => !f.staged).map((f) => f.path));
            }}
            label={`Include all files in ${headerName} in commit`}
          />
          {kind === 'named' && editingId != null && editingId === listId ? (
            <input
              autoFocus value={editingName}
              onChange={(e) => setEditingName(e.target.value)}
              onBlur={() => listId != null && handleRename(listId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && listId != null) handleRename(listId);
                if (e.key === 'Escape') setEditingId(null);
              }}
              className="bg-transparent border-b border-accent-primary text-text-primary text-[12px] focus:outline-none w-32"
            />
          ) : (
            <span className="text-[12px] font-semibold text-text-primary truncate">{headerName}</span>
          )}
          <span className="text-text-tertiary text-[11px] shrink-0">
            {groupFiles.length} file{groupFiles.length !== 1 ? 's' : ''}
          </span>
          {kind !== 'unversioned' && branch && (
            <span className="shrink-0 px-1.5 py-px rounded-[3px] bg-fill-hover text-text-secondary text-[10.5px] truncate max-w-[140px]" title={branch}>
              {branch}
            </span>
          )}
          <span className="flex-1" />
          {kind === 'default' && (
            creating ? (
              <div className="flex items-center gap-1 shrink-0">
                <input
                  autoFocus value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onBlur={() => { if (!newName.trim()) setCreating(false); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreate();
                    if (e.key === 'Escape') { setCreating(false); setNewName(''); }
                  }}
                  placeholder="new-list"
                  className="bg-elevation-0 ring-1 ring-border-light rounded text-[11px] px-2 py-0.5 text-text-primary w-28 focus:outline-none"
                />
                <button onClick={handleCreate} className="text-accent-primary" aria-label="Create changelist"><Check size={12} /></button>
              </div>
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="shrink-0 flex items-center gap-0.5 h-5 px-1.5 rounded text-[10.5px] text-accent-primary opacity-0 group-hover:opacity-100 hover:bg-accent-primary/10 transition-opacity"
                title="Create new changelist"
              >
                <Plus size={11} /> List
              </button>
            )
          )}
          {kind === 'named' && listId != null && (
            <div className="relative shrink-0">
              <button
                onClick={() => setMenuListId(isMenuOpen ? null : listId)}
                className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-fill-hover text-text-tertiary transition-opacity"
                aria-label="Changelist actions"
              >
                <MoreVertical size={12} />
              </button>
              {isMenuOpen && (
                <div className="absolute right-0 top-full mt-1 z-50 w-[140px] bg-elevation-3 ring-1 ring-seam-strong rounded-lg overflow-hidden py-1">
                  <button
                    onClick={() => { setEditingId(listId); setEditingName(headerName); setMenuListId(null); }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-text-primary hover:bg-fill-hover"
                  >
                    <Edit3 size={12} /> Rename
                  </button>
                  <button
                    onClick={() => { setMenuListId(null); handleDelete(listId, headerName); }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-red-400 hover:bg-red-500/10"
                  >
                    <Trash2 size={12} /> Delete
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {!isCollapsed && groupFiles.map(renderRow)}
      </div>
    );
  };

  return (
    <div ref={containerRef}>
      {renderGroup('Changes', 'default', grouped.get('default') ?? [], null)}
      {lists.filter((l) => l.id != null).map((l) =>
        renderGroup(l.name, 'named', grouped.get(l.id!) ?? [], l.id!),
      )}
      {unversioned.length > 0 && renderGroup('Unversioned Files', 'unversioned', unversioned, null)}

      {contextFile && (
        <div
          className="fixed z-50 bg-elevation-3 ring-1 ring-seam-strong rounded-lg overflow-hidden py-1 min-w-[180px]"
          style={{ left: contextFile.x, top: contextFile.y }}
        >
          <div className="px-3 py-1 text-text-tertiary text-[10px] uppercase tracking-wider">
            Move to changelist
          </div>
          <button
            onClick={() => { moveFile(contextFile.file.path, null); setContextFile(null); }}
            className="w-full flex items-center justify-between px-3 py-1.5 text-[12px] text-text-primary hover:bg-fill-hover"
          >
            Changes
            {assignments.get(contextFile.file.path) == null && <Check size={11} className="text-accent-primary" />}
          </button>
          {lists.filter((l) => l.id != null).map((l) => {
            const isCurrent = assignments.get(contextFile.file.path) === l.id;
            return (
              <button
                key={l.id}
                onClick={() => { moveFile(contextFile.file.path, l.id!); setContextFile(null); }}
                className="w-full flex items-center justify-between px-3 py-1.5 text-[12px] text-text-primary hover:bg-fill-hover"
              >
                {l.name}
                {isCurrent && <Check size={11} className="text-accent-primary" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
