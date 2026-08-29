import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  ChevronRight,
  ChevronDown,
  RefreshCw,
  FolderOpen,
  FileText,
  Scissors,
  Copy,
  ClipboardPaste,
  Edit3,
  Trash2,
  Link2,
  CornerDownRight,
  TerminalSquare,
} from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';
import { getFileIconUrl, getFolderIconUrl } from '../utils/fileIcons';
import { toast } from '../store/toastStore';
import { copyText } from '../lib/clipboard';
import { PanelHeader } from './ui/PanelHeader';
import { ListRow } from './ui/ListRow';

const isMac = navigator.platform.toUpperCase().includes('MAC');
const REVEAL_LABEL = isMac ? 'Reveal in Finder' : 'Show in File Explorer';

// Mirror the tag-color palette used by NewTerminalModal so terminals opened
// from the tree get the same cycling color tags as ones opened via the modal.
const TERMINAL_TAG_COLORS = [
  'bg-red-500',
  'bg-orange-500',
  'bg-yellow-500',
  'bg-green-500',
  'bg-blue-500',
  'bg-purple-500',
  'bg-pink-500',
];

interface ContextMenuState {
  x: number;
  y: number;
  path: string;
  isDir: boolean;
}

interface ClipboardState {
  paths: string[];
  mode: 'cut' | 'copy';
}

interface DirEntryInfo {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number;
}

interface TreeNode {
  entry: DirEntryInfo;
  children: TreeNode[] | null; // null = not loaded yet
  loading: boolean;
  expanded: boolean;
  error: string | null;
}

function makeNode(entry: DirEntryInfo): TreeNode {
  return { entry, children: null, loading: false, expanded: false, error: null };
}

function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

function parentDir(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  return idx === -1 ? trimmed : trimmed.slice(0, idx);
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  const trimmed = dir.replace(/[\\/]+$/, '');
  return `${trimmed}${sep}${name}`;
}

/** Relative path from `root` to `p`. Empty string if equal. Returns `p`
 *  unchanged when `p` is outside `root`. Treats both Windows and POSIX
 *  separators interchangeably so the result mirrors how the user wrote
 *  the path. */
function relativeToRoot(p: string, root: string): string {
  const normalize = (s: string) => s.replace(/[\\/]+$/, '').toLowerCase();
  const np = normalize(p);
  const nr = normalize(root);
  if (np === nr) return '';
  if (np.startsWith(nr + '\\') || np.startsWith(nr + '/')) {
    return p.slice(root.replace(/[\\/]+$/, '').length + 1);
  }
  return p;
}

export function FileTreePanel() {
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
  const terminals = useTerminalStore((s) => s.terminals);
  const createTerminal = useTerminalStore((s) => s.createTerminal);
  const pinnedRepoPath = useAppStore((s) => s.pinnedRepoPath);
  const defaultClaudeArgs = useAppStore((s) => s.defaultClaudeArgs);
  const setPinnedRepoPath = useAppStore((s) => s.setPinnedRepoPath);
  const openFileTab = useAppStore((s) => s.openFileTab);
  const activeFilePath = useAppStore((s) => s.activeFilePath);
  const changesRefreshTrigger = useAppStore((s) => s.changesRefreshTrigger);
  const triggerChangesRefresh = useAppStore((s) => s.triggerChangesRefresh);
  const collapsed = useAppStore((s) => s.explorerCollapsed);
  const toggleCollapsed = useAppStore((s) => s.toggleExplorerCollapsed);

  const activeCwd = useMemo(() => {
    if (!activeTerminalId) return null;
    return terminals.get(activeTerminalId)?.config.working_directory ?? null;
  }, [activeTerminalId, terminals]);

  const rootPath = pinnedRepoPath ?? activeCwd;

  const [rootChildren, setRootChildren] = useState<TreeNode[] | null>(null);
  const [rootLoading, setRootLoading] = useState(false);
  const [rootError, setRootError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [clipboard, setClipboard] = useState<ClipboardState | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ path: string; isDir: boolean } | null>(null);

  // Track expanded folders across refreshes by absolute path
  const expandedPathsRef = useRef<Set<string>>(new Set());

  // Close the context menu on outside click / Escape. Native mousedown is
  // used so the listener runs before React's click; we ignore mousedowns
  // that land inside the menu so its own buttons can still receive the
  // click (synthetic stopPropagation can't block a native document listener).
  useEffect(() => {
    if (!contextMenu) return;
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && target.closest('[data-context-menu="tree"]')) return;
      setContextMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    const onBlur = () => setContextMenu(null);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onBlur);
    };
  }, [contextMenu]);

  const openContextMenu = useCallback((e: React.MouseEvent, path: string, isDir: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    // The menu's height varies with item count - overestimate so it never
    // clips off the bottom of the viewport.
    const margin = 4;
    const menuWidth = 240;
    const menuHeight = 320;
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - margin);
    const y = Math.min(e.clientY, window.innerHeight - menuHeight - margin);
    setContextMenu({ x: Math.max(margin, x), y: Math.max(margin, y), path, isDir });
  }, []);

  const loadChildren = useCallback(async (path: string): Promise<DirEntryInfo[]> => {
    return await invoke<DirEntryInfo[]>('list_directory', { path });
  }, []);

  const refreshRoot = useCallback(async () => {
    if (!rootPath) {
      setRootChildren(null);
      setRootError(null);
      return;
    }
    setRootLoading(true);
    setRootError(null);
    try {
      const entries = await loadChildren(rootPath);
      // Preserve expansion state for paths still present.
      const existing = new Map<string, TreeNode>();
      const collect = (nodes: TreeNode[] | null) => {
        if (!nodes) return;
        for (const n of nodes) {
          existing.set(n.entry.path, n);
          if (n.children) collect(n.children);
        }
      };
      collect(rootChildren);

      const nextRoot: TreeNode[] = entries.map((e) => {
        const prev = existing.get(e.path);
        if (prev && prev.entry.is_dir === e.is_dir) {
          return { ...prev, entry: e };
        }
        return makeNode(e);
      });
      setRootChildren(nextRoot);
    } catch (err) {
      setRootError(typeof err === 'string' ? err : 'Failed to read folder');
      setRootChildren(null);
    } finally {
      setRootLoading(false);
    }
    // rootChildren intentionally excluded - this would cause infinite reloads;
    // refreshRoot is called on explicit triggers only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath, loadChildren]);

  useEffect(() => {
    expandedPathsRef.current = new Set();
    refreshRoot();
  }, [rootPath, changesRefreshTrigger]); // reload on terminal change and external refresh

  const updateNode = useCallback((targetPath: string, updater: (n: TreeNode) => TreeNode) => {
    setRootChildren((prev) => {
      if (!prev) return prev;
      const walk = (nodes: TreeNode[]): TreeNode[] =>
        nodes.map((n) => {
          if (n.entry.path === targetPath) return updater(n);
          if (n.children) {
            const nextChildren = walk(n.children);
            if (nextChildren !== n.children) return { ...n, children: nextChildren };
          }
          return n;
        });
      return walk(prev);
    });
  }, []);

  /** Re-list `folderPath`'s children in place, preserving sub-expansion. If
   *  the folder isn't currently in the tree, falls back to refreshing root. */
  const refreshFolder = useCallback(async (folderPath: string) => {
    if (!rootPath) return;
    if (folderPath === rootPath) {
      await refreshRoot();
      return;
    }
    try {
      const entries = await loadChildren(folderPath);
      let touched = false;
      setRootChildren((prev) => {
        if (!prev) return prev;
        const walk = (nodes: TreeNode[]): TreeNode[] =>
          nodes.map((n) => {
            if (n.entry.path === folderPath) {
              touched = true;
              const existing = new Map<string, TreeNode>();
              if (n.children) for (const c of n.children) existing.set(c.entry.path, c);
              const next: TreeNode[] = entries.map((e) => {
                const prev = existing.get(e.path);
                if (prev && prev.entry.is_dir === e.is_dir) return { ...prev, entry: e };
                return makeNode(e);
              });
              return { ...n, children: next };
            }
            if (n.children) {
              const nextChildren = walk(n.children);
              if (nextChildren !== n.children) return { ...n, children: nextChildren };
            }
            return n;
          });
        return walk(prev);
      });
      if (!touched) {
        // Folder wasn't expanded yet - refresh from the top so the next
        // expansion sees fresh data.
        await refreshRoot();
      }
    } catch {
      await refreshRoot();
    }
  }, [rootPath, refreshRoot, loadChildren]);

  const toggleExpand = useCallback(async (node: TreeNode) => {
    if (!node.entry.is_dir) return;
    const { path } = node.entry;
    // Collapse
    if (node.expanded) {
      expandedPathsRef.current.delete(path);
      updateNode(path, (n) => ({ ...n, expanded: false }));
      return;
    }
    // Expand - if children already loaded, just flip the flag
    if (node.children) {
      expandedPathsRef.current.add(path);
      updateNode(path, (n) => ({ ...n, expanded: true }));
      return;
    }
    // Lazy-load children
    updateNode(path, (n) => ({ ...n, loading: true, error: null }));
    try {
      const entries = await loadChildren(path);
      expandedPathsRef.current.add(path);
      updateNode(path, (n) => ({
        ...n,
        loading: false,
        expanded: true,
        children: entries.map(makeNode),
        error: null,
      }));
    } catch (err) {
      updateNode(path, (n) => ({
        ...n,
        loading: false,
        error: typeof err === 'string' ? err : 'Failed to read folder',
      }));
    }
  }, [loadChildren, updateNode]);

  // --- Context-menu actions ---

  const doReveal = useCallback(async (path: string) => {
    try {
      await invoke('reveal_in_file_manager', { path });
    } catch (err) {
      toast.error('Could not open', typeof err === 'string' ? err : String(err));
    }
  }, []);

  /** Spawn a new Claude terminal rooted at `path` and make it active. The new
   *  terminal becomes the active tab, so the Explorer (which roots at the
   *  active terminal's cwd) re-roots to show this folder. Clearing any pinned
   *  repo guarantees the tree follows the new terminal rather than staying on
   *  a repo pinned by the Changes panel. */
  const doOpenInTerminal = useCallback(async (path: string) => {
    try {
      const size = useTerminalStore.getState().terminals.size;
      const label = `Terminal ${size + 1}`;
      const colorTag = TERMINAL_TAG_COLORS[size % TERMINAL_TAG_COLORS.length];
      await createTerminal(
        label,
        path,
        [...defaultClaudeArgs],
        {},
        colorTag,
        basename(path),
      );
      setPinnedRepoPath(null);
    } catch (err) {
      toast.error('Could not open terminal', typeof err === 'string' ? err : String(err));
    }
  }, [createTerminal, defaultClaudeArgs, setPinnedRepoPath]);

  const doCopyPath = useCallback(async (path: string) => {
    const ok = await copyText(path);
    if (ok) toast.success('Path copied', path);
    else toast.error('Copy failed', 'Clipboard is unavailable');
  }, []);

  const doCopyRelativePath = useCallback(async (path: string) => {
    if (!rootPath) return;
    const rel = relativeToRoot(path, rootPath) || basename(path);
    const ok = await copyText(rel);
    if (ok) toast.success('Relative path copied', rel);
    else toast.error('Copy failed', 'Clipboard is unavailable');
  }, [rootPath]);

  const doPaste = useCallback(async (targetDir: string) => {
    if (!clipboard || clipboard.paths.length === 0) return;
    const cmd = clipboard.mode === 'cut' ? 'move_into_dir' : 'copy_into_dir';
    let okCount = 0;
    const errors: string[] = [];
    for (const source of clipboard.paths) {
      try {
        await invoke(cmd, { source, destDir: targetDir });
        okCount++;
      } catch (err) {
        errors.push(`${basename(source)}: ${err}`);
      }
    }
    // Refresh both source parent(s) and target so the tree matches disk.
    const parents = new Set<string>([targetDir]);
    if (clipboard.mode === 'cut') {
      for (const p of clipboard.paths) parents.add(parentDir(p));
    }
    for (const parent of parents) {
      await refreshFolder(parent);
    }
    if (clipboard.mode === 'cut') setClipboard(null);
    if (errors.length === 0) {
      toast.success(
        clipboard.mode === 'cut' ? 'Moved' : 'Copied',
        `${okCount} item${okCount === 1 ? '' : 's'} into ${basename(targetDir)}`,
      );
    } else {
      toast.error('Paste partially failed', errors.join('\n'));
    }
    triggerChangesRefresh();
  }, [clipboard, refreshFolder, triggerChangesRefresh]);

  const doRenameCommit = useCallback(async (oldPath: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === basename(oldPath)) {
      setRenamingPath(null);
      return;
    }
    if (/[\\/]/.test(trimmed)) {
      toast.error('Invalid name', 'Name cannot contain path separators');
      setRenamingPath(null);
      return;
    }
    const parent = parentDir(oldPath);
    const newPath = joinPath(parent, trimmed);
    try {
      await invoke('rename_path', { from: oldPath, to: newPath });
      setRenamingPath(null);
      await refreshFolder(parent);
      triggerChangesRefresh();
      toast.success('Renamed', `${basename(oldPath)} → ${trimmed}`);
    } catch (err) {
      toast.error('Rename failed', String(err));
      // Leave rename UI open so user can correct.
    }
  }, [refreshFolder, triggerChangesRefresh]);

  const doDelete = useCallback(async (path: string) => {
    try {
      await invoke('trash_path', { path });
      await refreshFolder(parentDir(path));
      triggerChangesRefresh();
      toast.success('Moved to trash', basename(path));
    } catch (err) {
      toast.error('Delete failed', String(err));
    } finally {
      setPendingDelete(null);
    }
  }, [refreshFolder, triggerChangesRefresh]);

  // --- Menu item construction ---

  const menuItems = useMemo(() => {
    if (!contextMenu) return [];
    const { path, isDir } = contextMenu;
    const isRoot = rootPath !== null && path === rootPath;
    const items: Array<
      | { kind: 'divider' }
      | {
          kind: 'item';
          label: string;
          shortcut?: string;
          icon: React.ReactNode;
          disabled?: boolean;
          danger?: boolean;
          onClick: () => void;
        }
    > = [];

    if (!isDir) {
      items.push({
        kind: 'item',
        label: 'Open',
        shortcut: 'Enter',
        icon: <FileText size={13} strokeWidth={1.75} />,
        onClick: () => { void openFileTab(path); },
      });
    }
    if (isDir) {
      items.push({
        kind: 'item',
        label: 'Open in New Terminal',
        icon: <TerminalSquare size={13} strokeWidth={1.75} />,
        onClick: () => { void doOpenInTerminal(path); },
      });
      items.push({
        kind: 'item',
        label: 'Refresh',
        shortcut: 'F5',
        icon: <RefreshCw size={13} strokeWidth={1.75} />,
        onClick: () => { void refreshFolder(path); },
      });
    }
    items.push({
      kind: 'item',
      label: REVEAL_LABEL,
      icon: <FolderOpen size={13} strokeWidth={1.75} />,
      onClick: () => { void doReveal(path); },
    });

    items.push({ kind: 'divider' });

    items.push({
      kind: 'item',
      label: 'Cut',
      shortcut: 'Ctrl+X',
      icon: <Scissors size={13} strokeWidth={1.75} />,
      disabled: isRoot,
      onClick: () => setClipboard({ paths: [path], mode: 'cut' }),
    });
    items.push({
      kind: 'item',
      label: 'Copy',
      shortcut: 'Ctrl+C',
      icon: <Copy size={13} strokeWidth={1.75} />,
      onClick: () => setClipboard({ paths: [path], mode: 'copy' }),
    });
    items.push({
      kind: 'item',
      label: 'Paste',
      shortcut: 'Ctrl+V',
      icon: <ClipboardPaste size={13} strokeWidth={1.75} />,
      disabled: !isDir || !clipboard || clipboard.paths.length === 0,
      onClick: () => { void doPaste(path); },
    });

    items.push({ kind: 'divider' });

    items.push({
      kind: 'item',
      label: 'Copy Path',
      icon: <Link2 size={13} strokeWidth={1.75} />,
      onClick: () => { void doCopyPath(path); },
    });
    items.push({
      kind: 'item',
      label: 'Copy Relative Path',
      icon: <CornerDownRight size={13} strokeWidth={1.75} />,
      disabled: !rootPath,
      onClick: () => { void doCopyRelativePath(path); },
    });

    items.push({ kind: 'divider' });

    items.push({
      kind: 'item',
      label: 'Rename…',
      shortcut: 'F2',
      icon: <Edit3 size={13} strokeWidth={1.75} />,
      disabled: isRoot,
      onClick: () => setRenamingPath(path),
    });
    items.push({
      kind: 'item',
      label: 'Delete',
      shortcut: 'Del',
      icon: <Trash2 size={13} strokeWidth={1.75} />,
      disabled: isRoot,
      danger: true,
      onClick: () => setPendingDelete({ path, isDir }),
    });

    return items;
  }, [contextMenu, rootPath, clipboard, openFileTab, refreshFolder, doReveal, doOpenInTerminal, doPaste, doCopyPath, doCopyRelativePath]);

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      <PanelHeader
        title="Explorer"
        collapsible
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        progress={{ active: !collapsed && rootLoading }}
        actions={
          !collapsed ? (
            <button
              onClick={refreshRoot}
              disabled={rootLoading}
              className="w-5 h-5 flex items-center justify-center rounded-[4px] hover:bg-fill-hover text-text-tertiary hover:text-text-secondary transition-colors disabled:opacity-40"
              title="Refresh"
            >
              <RefreshCw size={11} className={rootLoading ? 'animate-spin' : ''} strokeWidth={1.75} />
            </button>
          ) : undefined
        }
      />

      {/* Root path label */}
      {!collapsed && rootPath && (
        <div
          className="px-3 pb-1 flex-shrink-0 cursor-default"
          onContextMenu={(e) => openContextMenu(e, rootPath, true)}
        >
          <p className="text-text-tertiary text-[10.5px] font-mono truncate" title={rootPath}>
            {basename(rootPath)}
          </p>
        </div>
      )}

      {/* Tree content */}
      {!collapsed && <div className="flex-1 overflow-y-auto overflow-x-hidden py-1">
        {!rootPath && (
          <div className="px-3 py-2 text-text-tertiary text-[11px]">
            No active terminal
          </div>
        )}
        {rootPath && rootError && (
          <div className="px-3 py-2 text-red-400 text-[11px]">{rootError}</div>
        )}
        {rootPath && !rootError && rootChildren === null && rootLoading && (
          <div className="px-3 py-2 text-text-tertiary text-[11px]">Loading…</div>
        )}
        {rootChildren && rootChildren.length === 0 && (
          <div className="px-3 py-2 text-text-tertiary text-[11px]">(empty folder)</div>
        )}
        {rootChildren && rootChildren.map((node) => (
          <TreeRow
            key={node.entry.path}
            node={node}
            depth={0}
            onToggle={toggleExpand}
            onOpenFile={(p) => { void openFileTab(p); }}
            onContextMenu={openContextMenu}
            cutPaths={clipboard?.mode === 'cut' ? clipboard.paths : null}
            renamingPath={renamingPath}
            onRenameCommit={doRenameCommit}
            onRenameCancel={() => setRenamingPath(null)}
            activeFilePath={activeFilePath}
          />
        ))}
      </div>}

      {/* Right-click context menu */}
      {contextMenu && menuItems.length > 0 && (
        <div
          role="menu"
          data-context-menu="tree"
          className="fixed z-[80] min-w-[220px] material-popover rounded-md py-1 select-none"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {menuItems.map((item, i) => {
            if (item.kind === 'divider') {
              return <div key={`d${i}`} className="my-1 border-t border-seam" />;
            }
            return (
              <button
                key={`${item.label}-${i}`}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  setContextMenu(null);
                  item.onClick();
                }}
                className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-[12px] transition-colors ${
                  item.disabled
                    ? 'text-text-tertiary/50 cursor-not-allowed'
                    : item.danger
                    ? 'text-red-400 hover:bg-red-500/10'
                    : 'text-text-primary hover:bg-fill-hover'
                }`}
              >
                <span className={item.disabled ? 'opacity-50' : 'text-text-tertiary'}>
                  {item.icon}
                </span>
                <span className="flex-1">{item.label}</span>
                {item.shortcut && (
                  <span className="text-[10.5px] text-text-tertiary tabular-nums">
                    {item.shortcut}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Delete confirmation dialog */}
      {pendingDelete && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50"
          onClick={() => setPendingDelete(null)}
        >
          <div
            className="material-popover rounded-md p-4 w-[360px]"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-text-primary text-[13px] font-semibold mb-1">
              Move to {isMac ? 'Trash' : 'Recycle Bin'}?
            </h3>
            <p className="text-text-secondary text-[12px] mb-1">
              <span className="font-mono text-text-primary">{basename(pendingDelete.path)}</span>
              {pendingDelete.isDir && (
                <span className="text-text-tertiary"> and all its contents</span>
              )}
            </p>
            <p className="text-text-tertiary text-[11px] mb-4">
              You can restore it from the {isMac ? 'Trash' : 'Recycle Bin'} if you change your mind.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="px-3 h-8 text-text-secondary hover:text-text-primary hover:bg-fill-hover rounded-md text-[12px] transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => { void doDelete(pendingDelete.path); }}
                className="px-3 h-8 bg-red-500 hover:bg-red-600 text-white rounded-md text-[12px] font-medium transition-colors"
              >
                Move to {isMac ? 'Trash' : 'Recycle Bin'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface TreeRowProps {
  node: TreeNode;
  depth: number;
  onToggle: (n: TreeNode) => void;
  onOpenFile: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, path: string, isDir: boolean) => void;
  cutPaths: string[] | null;
  renamingPath: string | null;
  onRenameCommit: (oldPath: string, newName: string) => void;
  onRenameCancel: () => void;
  activeFilePath: string | null;
}

function TreeRow({
  node,
  depth,
  onToggle,
  onOpenFile,
  onContextMenu,
  cutPaths,
  renamingPath,
  onRenameCommit,
  onRenameCancel,
  activeFilePath,
}: TreeRowProps) {
  const { entry } = node;
  const indent = 8 + depth * 12;
  const isRenaming = renamingPath === entry.path;
  const isCut = cutPaths !== null && cutPaths.includes(entry.path);
  const cutClass = isCut ? 'opacity-50' : '';

  const renameInput = isRenaming && (
    <RenameInput
      initial={entry.name}
      onCommit={(name) => onRenameCommit(entry.path, name)}
      onCancel={onRenameCancel}
    />
  );

  if (entry.is_dir) {
    return (
      <>
        <ListRow
          as="div"
          variant="compact"
          onClick={() => { if (!isRenaming) onToggle(node); }}
          onContextMenu={(e) => onContextMenu(e, entry.path, true)}
          style={{ paddingLeft: indent }}
          className={cutClass}
          leading={
            <>
              {node.expanded ? (
                <ChevronDown size={11} className="text-text-tertiary shrink-0" strokeWidth={2} />
              ) : (
                <ChevronRight size={11} className="text-text-tertiary shrink-0" strokeWidth={2} />
              )}
              <img
                src={getFolderIconUrl(entry.name, node.expanded)}
                alt=""
                aria-hidden="true"
                draggable={false}
                className="w-[14px] h-[14px] shrink-0 select-none"
              />
            </>
          }
        >
          {isRenaming ? renameInput : (
            <span className="text-[12px] text-text-primary truncate" title={entry.name}>
              {entry.name}
            </span>
          )}
        </ListRow>
        {node.expanded && node.loading && (
          <div className="text-text-tertiary text-[11px]" style={{ paddingLeft: indent + 24 }}>
            Loading…
          </div>
        )}
        {node.expanded && node.error && (
          <div className="text-red-400 text-[11px]" style={{ paddingLeft: indent + 24 }}>
            {node.error}
          </div>
        )}
        {node.expanded && node.children && node.children.map((child) => (
          <TreeRow
            key={child.entry.path}
            node={child}
            depth={depth + 1}
            onToggle={onToggle}
            onOpenFile={onOpenFile}
            onContextMenu={onContextMenu}
            cutPaths={cutPaths}
            renamingPath={renamingPath}
            onRenameCommit={onRenameCommit}
            onRenameCancel={onRenameCancel}
            activeFilePath={activeFilePath}
          />
        ))}
      </>
    );
  }

  // File row
  const isActive = activeFilePath === entry.path;
  return (
    <ListRow
      as="div"
      variant="compact"
      selected={isActive}
      onClick={() => { if (!isRenaming) onOpenFile(entry.path); }}
      onContextMenu={(e) => onContextMenu(e, entry.path, false)}
      title={entry.path}
      style={{ paddingLeft: indent + 12 }}
      className={cutClass}
      leading={
        <img
          src={getFileIconUrl(entry.name)}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="w-[14px] h-[14px] shrink-0 select-none"
        />
      }
    >
      {isRenaming ? renameInput : (
        <span className={`text-[12px] truncate ${isActive ? 'text-text-primary' : 'text-text-secondary'}`}>
          {entry.name}
        </span>
      )}
    </ListRow>
  );
}

interface RenameInputProps {
  initial: string;
  onCommit: (newName: string) => void;
  onCancel: () => void;
}

function RenameInput({ initial, onCommit, onCancel }: RenameInputProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Track whether commit/cancel already fired so the blur handler doesn't
  // re-fire it (Enter calls commit, then the input loses focus → blur).
  const settledRef = useRef(false);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    // Select just the basename (before extension) the way IntelliJ does.
    const dot = initial.lastIndexOf('.');
    if (dot > 0) el.setSelectionRange(0, dot);
    else el.select();
  }, [initial]);

  return (
    <input
      ref={inputRef}
      defaultValue={initial}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (settledRef.current) return;
          settledRef.current = true;
          onCommit((e.target as HTMLInputElement).value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          if (settledRef.current) return;
          settledRef.current = true;
          onCancel();
        }
      }}
      onBlur={(e) => {
        if (settledRef.current) return;
        settledRef.current = true;
        onCommit(e.currentTarget.value);
      }}
      className="flex-1 min-w-0 bg-bg-primary ring-1 ring-accent-primary rounded-[3px] h-[18px] px-1 text-[12px] text-text-primary font-mono focus:outline-none"
    />
  );
}
