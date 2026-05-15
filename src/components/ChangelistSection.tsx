// IntelliJ-style Changelists Lite UI.
// Renders the unstaged "Changes" portion of the FileChangesPanel as one section
// per named changelist + a Default group for unassigned files.
//
// Backed by 6 Tauri commands in src-tauri/src/commands.rs:
//   list_changelists, create_changelist, rename_changelist, delete_changelist,
//   assign_files_to_changelist, get_changelist_assignments.
//
// "Default" is implicit. Mappings persist across commits (sticky).

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Plus, ChevronRight, ChevronDown, MoreVertical, Edit3, Trash2, Check,
  FilePlus, FileEdit, FileX, FileQuestion, ArrowRightLeft, Loader2,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store/appStore';
import { toast } from '../store/toastStore';
import { getFileIconUrl } from '../utils/fileIcons';

interface FileChange {
  path: string;
  status: string;
  staged: boolean;
}

interface ChangelistInfo {
  id: number | null;
  name: string;
  is_default: boolean;
}

interface Props {
  repoPath: string;
  unstagedFiles: FileChange[];
  onStage: (paths: string[]) => Promise<void> | void;
  refreshTrigger: number;
}

const statusConfig: Record<string, { color: string; icon: React.ReactNode }> = {
  new:       { color: 'text-green-400',  icon: <FilePlus size={14} /> },
  modified:  { color: 'text-yellow-400', icon: <FileEdit size={14} /> },
  deleted:   { color: 'text-red-400',    icon: <FileX size={14} /> },
  renamed:   { color: 'text-blue-400',   icon: <ArrowRightLeft size={14} /> },
  untracked: { color: 'text-text-tertiary', icon: <FileQuestion size={14} /> },
};

function pathBasename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

export function ChangelistSection({ repoPath, unstagedFiles, onStage, refreshTrigger }: Props) {
  const confirmDelete = useAppStore((s) => s.vcsChangelistsConfirmDelete);
  const triggerChangesRefresh = useAppStore((s) => s.triggerChangesRefresh);

  const onDiscard = useCallback(async (file: FileChange) => {
    const label = file.path.split(/[\\/]/).pop() ?? file.path;
    const verb = file.status === 'untracked' ? 'Delete' : 'Discard';
    const ok = window.confirm(`${verb}: ${label}? This cannot be undone.`);
    if (!ok) return;
    try {
      await invoke('git_discard_file', {
        path: repoPath, file: file.path,
        untracked: file.status === 'untracked',
      });
      toast.success(`${verb}ed`, label);
      triggerChangesRefresh();
    } catch (err) {
      toast.error(`${verb} failed`, typeof err === 'string' ? err : 'Unknown error');
    }
  }, [repoPath, triggerChangesRefresh]);

  const [lists, setLists] = useState<ChangelistInfo[]>([{ id: null, name: 'Default', is_default: true }]);
  const [assignments, setAssignments] = useState<Map<string, number>>(new Map());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');
  const [menuListId, setMenuListId] = useState<number | null>(null);
  const [contextFile, setContextFile] = useState<{ file: FileChange; x: number; y: number } | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());

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

  const grouped = useMemo(() => {
    const out = new Map<number | 'default', FileChange[]>();
    out.set('default', []);
    for (const list of lists) if (list.id != null) out.set(list.id, []);
    for (const f of unstagedFiles) {
      const assigned = assignments.get(f.path);
      if (assigned != null && out.has(assigned)) out.get(assigned)!.push(f);
      else out.get('default')!.push(f);
    }
    return out;
  }, [lists, unstagedFiles, assignments]);

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
      const ok = window.confirm(`Delete changelist "${name}"? Its files revert to Default.`);
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

  const renderRow = (file: FileChange) => {
    const config = statusConfig[file.status] || statusConfig.untracked;
    const isBusy = busy.has(file.path);
    return (
      <div
        key={file.path}
        className="group flex items-center gap-1 ml-1 px-2 py-1 rounded hover:bg-white/[0.04] cursor-pointer"
        onContextMenu={(e) => {
          e.preventDefault();
          setContextFile({ file, x: e.clientX, y: e.clientY });
        }}
      >
        <img
          src={getFileIconUrl(pathBasename(file.path))}
          alt="" aria-hidden draggable={false}
          className="w-[14px] h-[14px] shrink-0 select-none"
        />
        <span className={`${config.color} shrink-0`}>{config.icon}</span>
        <p className={`flex-1 text-[12px] font-mono truncate ${config.color}`} title={file.path}>
          {file.path}
        </p>
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (isBusy) return;
            setBusy((b) => new Set(b).add(file.path));
            Promise.resolve(onStage([file.path])).finally(() => {
              setBusy((b) => { const n = new Set(b); n.delete(file.path); return n; });
            });
          }}
          className="shrink-0 p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity text-accent-primary hover:bg-accent-primary/15"
          title="Stage file"
        >
          {isBusy ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onDiscard(file); }}
          className="shrink-0 p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity text-text-tertiary hover:bg-red-500/20 hover:text-red-400"
          title={file.status === 'untracked' ? 'Delete untracked file' : 'Discard all changes'}
        >
          <Trash2 size={11} />
        </button>
      </div>
    );
  };

  const renderGroup = (headerName: string, isDefault: boolean, files: FileChange[], listId: number | null) => {
    const isCollapsed = collapsed.has(headerName);
    const isMenuOpen = menuListId === listId;
    return (
      <div key={headerName + (listId ?? '')} className="mb-2">
        <div className="flex items-center justify-between px-2 py-1 border-b border-border/30 mb-1">
          <button
            onClick={() => {
              const next = new Set(collapsed);
              if (next.has(headerName)) next.delete(headerName); else next.add(headerName);
              setCollapsed(next);
            }}
            className="flex items-center gap-1.5 text-text-secondary hover:text-text-primary min-w-0 flex-1 text-left"
          >
            {isCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
            {editingId === listId ? (
              <input
                autoFocus value={editingName}
                onChange={(e) => setEditingName(e.target.value)}
                onBlur={() => listId != null && handleRename(listId)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && listId != null) handleRename(listId);
                  if (e.key === 'Escape') setEditingId(null);
                }}
                className="bg-transparent border-b border-accent-primary text-text-primary text-[11px] font-semibold uppercase tracking-wider focus:outline-none w-32"
              />
            ) : (
              <span className="text-[11px] font-semibold uppercase tracking-wider truncate">{headerName}</span>
            )}
            <span className="text-text-tertiary text-[11px]">({files.length})</span>
          </button>
          <div className="flex items-center gap-1">
            {files.length > 0 && (
              <button
                onClick={() => onStage(files.map((f) => f.path))}
                className="flex items-center gap-0.5 h-5 px-1.5 rounded text-[10.5px] text-accent-primary hover:bg-accent-primary/10 transition-colors"
                title="Stage all files in this list"
              >
                <Plus size={11} /> Stage all
              </button>
            )}
            {!isDefault && listId != null && (
              <div className="relative">
                <button
                  onClick={() => setMenuListId(isMenuOpen ? null : listId)}
                  className="p-0.5 rounded hover:bg-white/[0.06] text-text-tertiary"
                  aria-label="Changelist actions"
                >
                  <MoreVertical size={12} />
                </button>
                {isMenuOpen && (
                  <div className="absolute right-0 top-full mt-1 z-50 w-[140px] bg-elevation-3 ring-1 ring-white/[0.08] rounded-lg shadow-elevation-3 overflow-hidden py-1">
                    <button
                      onClick={() => { setEditingId(listId); setEditingName(headerName); setMenuListId(null); }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-text-primary hover:bg-white/[0.04]"
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
        </div>

        {!isCollapsed && (
          <div>
            {files.length === 0
              ? <p className="px-3 py-1 text-text-tertiary text-[11px] italic">No files in this list.</p>
              : files.map(renderRow)}
          </div>
        )}
      </div>
    );
  };

  return (
    <div ref={containerRef}>
      <div className="flex items-center justify-between px-2 py-1 mb-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
          Unstaged
        </span>
        {creating ? (
          <div className="flex items-center gap-1">
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
            <button onClick={handleCreate} className="text-accent-primary"><Check size={12} /></button>
          </div>
        ) : (
          <button
            onClick={() => setCreating(true)}
            className="flex items-center gap-0.5 h-5 px-1.5 rounded text-[10.5px] text-accent-primary hover:bg-accent-primary/10"
            title="Create new changelist"
          >
            <Plus size={11} /> List
          </button>
        )}
      </div>

      {renderGroup('Default', true, grouped.get('default') ?? [], null)}
      {lists.filter((l) => l.id != null).map((l) =>
        renderGroup(l.name, false, grouped.get(l.id!) ?? [], l.id!),
      )}

      {contextFile && (
        <div
          className="fixed z-50 bg-elevation-3 ring-1 ring-white/[0.08] rounded-lg shadow-elevation-3 overflow-hidden py-1 min-w-[180px]"
          style={{ left: contextFile.x, top: contextFile.y }}
        >
          <div className="px-3 py-1 text-text-tertiary text-[10px] uppercase tracking-wider">
            Move to changelist
          </div>
          <button
            onClick={() => { moveFile(contextFile.file.path, null); setContextFile(null); }}
            className="w-full flex items-center justify-between px-3 py-1.5 text-[12px] text-text-primary hover:bg-white/[0.04]"
          >
            Default
            {assignments.get(contextFile.file.path) == null && <Check size={11} className="text-accent-primary" />}
          </button>
          {lists.filter((l) => l.id != null).map((l) => {
            const isCurrent = assignments.get(contextFile.file.path) === l.id;
            return (
              <button
                key={l.id}
                onClick={() => { moveFile(contextFile.file.path, l.id!); setContextFile(null); }}
                className="w-full flex items-center justify-between px-3 py-1.5 text-[12px] text-text-primary hover:bg-white/[0.04]"
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

