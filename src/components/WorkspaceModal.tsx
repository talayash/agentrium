import { useState, useEffect } from 'react';
import { Save, Trash2, FolderOpen, Play } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store/appStore';
import type { SavedTerminalConfig } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';
import { toast } from '../store/toastStore';
import { reportInvokeFailure } from '../lib/errorReporter';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';

interface WorkspaceInfo {
  name: string;
  terminal_count: number;
  created_at: string;
}

export function WorkspaceModal() {
  const { closeWorkspaceModal } = useAppStore();
  const { terminals, createTerminal } = useTerminalStore();

  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState<WorkspaceInfo | null>(null);
  const [newName, setNewName] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);

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

  const handleLoadWorkspace = async () => {
    if (!selectedWorkspace) return;
    setLoading(true);
    try {
      const configs = await invoke<SavedTerminalConfig[]>('load_workspace', { name: selectedWorkspace.name });
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
      toast.success('Workspace Loaded', `"${selectedWorkspace.name}" with ${configs.length} terminal${configs.length !== 1 ? 's' : ''}.`);
      closeWorkspaceModal();
    } catch (err) {
      toast.error('Load Failed', 'Could not load workspace.');
      reportInvokeFailure('load_workspace', err);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteWorkspace = async () => {
    if (!selectedWorkspace) return;
    try {
      const name = selectedWorkspace.name;
      await invoke('delete_workspace', { name });
      setSelectedWorkspace(null);
      await loadWorkspaces();
      toast.success('Workspace Deleted', `"${name}" has been removed.`);
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
    <Modal
      onClose={closeWorkspaceModal}
      closeOn="doubleClick"
      scrimClassName="bg-black/50 z-50"
      panelClassName="w-full max-w-3xl"
      showHeader
      title="Workspaces"
      icon={<FolderOpen size={16} className="text-text-secondary" />}
    >
        {/* Content */}
        <div className="flex h-[400px]">
          {/* Left: Workspace List + Save */}
          <div className="w-64 border-r border-border p-3 flex flex-col">
            {/* Save Current */}
            <div className="flex gap-1.5 mb-3">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSaveWorkspace(); }}
                placeholder="Workspace name..."
                className="flex-1 bg-bg-primary ring-1 ring-border-light rounded-md h-8 px-2 text-text-primary text-[12px] focus:outline-none focus:ring-[3px] focus:ring-accent-primary/45 transition-colors"
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

            {/* Workspace List */}
            <div className="flex-1 overflow-y-auto space-y-0.5">
              {workspaces.map((ws) => (
                <div
                  key={ws.name}
                  onClick={() => setSelectedWorkspace(ws)}
                  className={`p-2 rounded-md cursor-pointer transition-colors ${
                    selectedWorkspace?.name === ws.name
                      ? 'bg-accent-primary/10 ring-1 ring-accent-primary/30'
                      : 'hover:bg-fill-hover'
                  }`}
                >
                  <p className="text-text-primary text-[12px] font-medium truncate">{ws.name}</p>
                  <p className="text-text-tertiary text-[11px]">
                    {ws.terminal_count} terminal{ws.terminal_count !== 1 ? 's' : ''}
                  </p>
                </div>
              ))}

              {workspaces.length === 0 && (
                <p className="text-text-tertiary text-[12px] text-center py-4">
                  No saved workspaces
                </p>
              )}
            </div>
          </div>

          {/* Right: Details */}
          <div className="flex-1 p-4 flex flex-col">
            {selectedWorkspace ? (
              <>
                <div className="flex-1 space-y-3">
                  <div>
                    <label className="block text-text-tertiary text-[11px] mb-0.5">Name</label>
                    <p className="text-text-primary text-[14px] font-medium">{selectedWorkspace.name}</p>
                  </div>
                  <div>
                    <label className="block text-text-tertiary text-[11px] mb-0.5">Terminals</label>
                    <p className="text-text-primary text-[13px]">
                      {selectedWorkspace.terminal_count} terminal{selectedWorkspace.terminal_count !== 1 ? 's' : ''}
                    </p>
                  </div>
                  <div>
                    <label className="block text-text-tertiary text-[11px] mb-0.5">Created</label>
                    <p className="text-text-primary text-[13px]">{formatDate(selectedWorkspace.created_at)}</p>
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-4 border-t border-border">
                  <Button
                    variant="danger"
                    onClick={handleDeleteWorkspace}
                    icon={<Trash2 size={14} />}
                  >
                    Delete
                  </Button>
                  <Button
                    variant="primary"
                    onClick={handleLoadWorkspace}
                    disabled={loading}
                    loading={loading}
                    icon={<Play size={14} />}
                  >
                    {loading ? 'Loading...' : 'Load Workspace'}
                  </Button>
                </div>
              </>
            ) : (
              <div className="h-full flex items-center justify-center text-text-tertiary text-[13px]">
                Select a workspace or save the current session
              </div>
            )}
          </div>
        </div>
    </Modal>
  );
}
