import { useState, useEffect } from 'react';
import { Save, Trash2, Play, FolderOpen } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useTerminalStore } from '../store/terminalStore';
import type { SavedTerminalConfig } from '../store/appStore';
import { toast } from '../store/toastStore';
import { reportInvokeFailure } from '../lib/errorReporter';
import { Button } from './ui/Button';

interface WorkspaceInfo {
  name: string;
  terminal_count: number;
  created_at: string;
}

/**
 * Inspector-panel version of the workspace manager (save/load/delete named
 * terminal layouts). Same IPC surface as the WorkspaceModal, laid out
 * vertically for the 400px inspector column.
 */
export function WorkspacesPanel() {
  const { terminals, createTerminal } = useTerminalStore();

  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [newName, setNewName] = useState('');
  const [saving, setSaving] = useState(false);
  const [loadingName, setLoadingName] = useState<string | null>(null);

  useEffect(() => {
    loadWorkspaces();
  }, []);

  const loadWorkspaces = async () => {
    try {
      const loaded = await invoke<WorkspaceInfo[]>('get_workspaces');
      setWorkspaces(loaded);
    } catch (err) {
      reportInvokeFailure('get_workspaces', err);
    }
  };

  const handleSaveWorkspace = async () => {
    if (!newName.trim()) return;
    setSaving(true);
    try {
      const configs = Array.from(terminals.values()).map(t => t.config);
      const name = newName.trim();
      await invoke('save_workspace', { name, terminals: configs });
      setNewName('');
      await loadWorkspaces();
      toast.success('Workspace Saved', `"${name}" with ${configs.length} terminal${configs.length !== 1 ? 's' : ''}.`);
    } catch (err) {
      toast.error('Save Failed', 'Could not save workspace.');
      reportInvokeFailure('save_workspace', err);
    } finally {
      setSaving(false);
    }
  };

  const handleLoadWorkspace = async (ws: WorkspaceInfo) => {
    setLoadingName(ws.name);
    try {
      const configs = await invoke<SavedTerminalConfig[]>('load_workspace', { name: ws.name });
      for (const config of configs) {
        await createTerminal(
          config.label,
          config.working_directory,
          config.claude_args,
          config.env_vars,
          config.color_tag ?? undefined,
          config.nickname ?? undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          config.agent,
        );
      }
      toast.success('Workspace Loaded', `"${ws.name}" with ${configs.length} terminal${configs.length !== 1 ? 's' : ''}.`);
    } catch (err) {
      toast.error('Load Failed', 'Could not load workspace.');
      reportInvokeFailure('load_workspace', err);
    } finally {
      setLoadingName(null);
    }
  };

  const handleDeleteWorkspace = async (ws: WorkspaceInfo) => {
    try {
      await invoke('delete_workspace', { name: ws.name });
      await loadWorkspaces();
      toast.success('Workspace Deleted', `"${ws.name}" has been removed.`);
    } catch (err) {
      toast.error('Delete Failed', 'Could not delete workspace.');
      reportInvokeFailure('delete_workspace', err);
    }
  };

  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    } catch {
      return dateStr;
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Save current session */}
      <div className="p-3 border-b border-[var(--seam)]">
        <div className="flex gap-1.5">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSaveWorkspace(); }}
            placeholder="Workspace name..."
            className="flex-1 min-w-0 bg-bg-primary ring-1 ring-border-light rounded-md h-8 px-2 text-text-primary text-[12px] focus:outline-none focus:ring-[3px] focus:ring-accent-primary/45 transition-colors"
          />
          <Button
            variant="primary"
            size="sm"
            onClick={handleSaveWorkspace}
            disabled={!newName.trim() || saving || terminals.size === 0}
            loading={saving}
            icon={<Save size={12} />}
            className="h-8 flex-shrink-0"
          >
            Save
          </Button>
        </div>
        <p className="text-text-tertiary text-[11px] mt-1.5">
          Saves the current terminal layout as a named workspace.
        </p>
      </div>

      {/* Workspace list */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {workspaces.map((ws) => (
          <div
            key={ws.name}
            className="group p-2 rounded-md hover:bg-fill-hover transition-colors"
          >
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-text-primary text-[12px] font-medium truncate">{ws.name}</p>
                <p className="text-text-tertiary text-[11px]">
                  {ws.terminal_count} terminal{ws.terminal_count !== 1 ? 's' : ''} · {formatDate(ws.created_at)}
                </p>
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => handleLoadWorkspace(ws)}
                  disabled={loadingName !== null}
                  aria-label={`Load workspace ${ws.name}`}
                  title="Load workspace"
                  className="w-7 h-7 rounded-md flex items-center justify-center text-text-tertiary hover:text-accent-primary hover:bg-fill-active transition-colors disabled:opacity-50"
                >
                  <Play size={13} />
                </button>
                <button
                  onClick={() => handleDeleteWorkspace(ws)}
                  aria-label={`Delete workspace ${ws.name}`}
                  title="Delete workspace"
                  className="w-7 h-7 rounded-md flex items-center justify-center text-text-tertiary hover:text-red-400 hover:bg-fill-active transition-colors"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          </div>
        ))}

        {workspaces.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center gap-2 py-10 text-text-tertiary">
            <FolderOpen size={20} strokeWidth={1.5} />
            <p className="text-[12px]">No saved workspaces</p>
          </div>
        )}
      </div>
    </div>
  );
}
