import { useState, useEffect } from 'react';
import { X, Plus, Trash2, Save, FolderOpen, User } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useAppStore } from '../store/appStore';
import { toast } from '../store/toastStore';
import { reportInvokeFailure } from '../lib/errorReporter';
import { v4 as uuidv4 } from 'uuid';
import { specFor, type AgentKind } from '../lib/agents';
import { AgentPicker } from './AgentPicker';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';
import { ListRow } from './ui/ListRow';
import { EmptyState } from './ui/EmptyState';

interface PreviewProfile {
  enabled: boolean;
  url_override?: string | null;
  framework_hint?: string | null;
}

interface ConfigProfile {
  id: string;
  name: string;
  description: string | null;
  working_directory: string;
  // Legacy single args list. The backend mirrors agent_args[profile.agent]
  // into this field on save, so any read that hasn't been updated still
  // gets the args a launch would actually use.
  claude_args: string[];
  env_vars: Record<string, string>;
  is_default: boolean;
  agent: AgentKind;
  preview?: PreviewProfile | null;
  // Per-agent args map. When the user picks Claude, we show/edit
  // agent_args.claude; picking Codex switches to agent_args.codex; etc.
  // A missing entry falls back to claude_args (for profiles saved before
  // this field existed).
  agent_args?: Partial<Record<AgentKind, string[]>>;
}

export function ProfileModal() {
  const { closeProfileModal, editingProfileId } = useAppStore();
  const [profiles, setProfiles] = useState<ConfigProfile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<ConfigProfile | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    loadProfiles();
  }, []);

  useEffect(() => {
    if (editingProfileId && profiles.length > 0) {
      const profile = profiles.find(p => p.id === editingProfileId);
      if (profile) setSelectedProfile(profile);
    }
  }, [editingProfileId, profiles]);

  const loadProfiles = async () => {
    try {
      const loadedProfiles = await invoke<ConfigProfile[]>('get_profiles');
      setProfiles(loadedProfiles);
    } catch (err) {
      reportInvokeFailure('get_profiles', err);
    }
  };

  const handleCreateProfile = () => {
    setIsCreating(true);
    setSelectedProfile({
      id: uuidv4(),
      name: 'New Profile',
      description: '',
      working_directory: '',
      claude_args: [],
      env_vars: {},
      is_default: false,
      agent: 'claude',
      agent_args: { claude: [], codex: [], cursor: [], antigravity: [] },
    });
  };

  const [saveError, setSaveError] = useState<string | null>(null);

  const handleSaveProfile = async () => {
    if (!selectedProfile) return;
    setSaveError(null);
    try {
      await invoke('save_profile', { profile: selectedProfile });
      await loadProfiles();
      setIsCreating(false);
      toast.success('Profile Saved', `"${selectedProfile.name}" has been saved.`);
    } catch (err) {
      setSaveError(String(err));
      toast.error('Save Failed', String(err));
      reportInvokeFailure('save_profile', err);
    }
  };

  const handleBrowseDirectory = async () => {
    if (!selectedProfile) return;
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: selectedProfile.working_directory || undefined,
      });
      if (selected && typeof selected === 'string') {
        setSelectedProfile({ ...selectedProfile, working_directory: selected });
      }
    } catch (error) {
      reportInvokeFailure('dialog_open_directory', error);
    }
  };

  const handleDeleteProfile = async (id: string) => {
    setSaveError(null);
    try {
      const profileName = profiles.find(p => p.id === id)?.name || 'Profile';
      await invoke('delete_profile', { id });
      await loadProfiles();
      if (selectedProfile?.id === id) {
        setSelectedProfile(null);
      }
      toast.success('Profile Deleted', `"${profileName}" has been removed.`);
    } catch (err) {
      setSaveError(String(err));
      toast.error('Delete Failed', String(err));
      reportInvokeFailure('delete_profile', err);
    }
  };

  return (
    <Modal
      onClose={closeProfileModal}
      closeOn="doubleClick"
      scrimClassName="bg-black/50 z-[60]"
      panelClassName="w-full max-w-3xl"
    >
        {/* Header */}
        <div className="flex items-center justify-between px-4 h-11 bg-elevation-2 border-b border-seam">
          <h2 className="text-text-primary text-[14px] font-semibold">Configuration Profiles</h2>
          <button
            onClick={closeProfileModal}
            className="p-1 rounded hover:bg-fill-hover text-text-tertiary transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="flex h-[500px]">
          {/* Profile List */}
          <div className="w-64 border-r border-seam bg-black/20 p-3 flex flex-col">
            <Button
              variant="primary"
              size="sm"
              onClick={handleCreateProfile}
              icon={<Plus size={14} />}
              className="w-full mb-3"
            >
              New Profile
            </Button>

            <div className="flex-1 overflow-y-auto space-y-0.5">
              {profiles.map((profile) => (
                <ListRow
                  key={profile.id}
                  selected={selectedProfile?.id === profile.id}
                  onClick={() => {
                    setSelectedProfile(profile);
                    setIsCreating(false);
                  }}
                  className="items-start py-1.5"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-text-primary text-[12px] font-medium truncate">{profile.name}</p>
                    <p className="text-text-tertiary text-[11px] truncate">{profile.description || 'No description'}</p>
                  </div>
                </ListRow>
              ))}

              {profiles.length === 0 && (
                <EmptyState
                  icon={<User size={20} strokeWidth={1.75} />}
                  title="No profiles yet"
                  description="Save Claude command-line flags and env vars as reusable profiles."
                  compact
                />
              )}
            </div>
          </div>

          {/* Profile Editor */}
          <div className="flex-1 p-4 overflow-y-auto">
            {selectedProfile ? (
              <div className="space-y-4">
                <div>
                  <label className="block text-text-secondary text-[12px] mb-1.5">Agent</label>
                  <AgentPicker
                    value={selectedProfile.agent}
                    onChange={(kind) => {
                      // Mirror the newly-shown agent's stored args into
                      // claude_args so a save-without-edit writes the right
                      // list. When the target agent has no entry yet, show
                      // empty - NOT the previous agent's list. Falling back
                      // to claude_args here caused the switched-to agent to
                      // inherit whatever the previous agent had staged.
                      const nextArgs = selectedProfile.agent_args?.[kind] ?? [];
                      setSelectedProfile({
                        ...selectedProfile,
                        agent: kind,
                        claude_args: nextArgs,
                      });
                    }}
                  />
                  <p className="text-text-tertiary text-[11px] mt-1">
                    Runs as <code className="text-text-secondary">{specFor(selectedProfile.agent).binary} ...</code>
                  </p>
                </div>

                <div>
                  <label className="block text-text-secondary text-[12px] mb-1.5">Name</label>
                  <input
                    type="text"
                    value={selectedProfile.name}
                    onChange={(e) => setSelectedProfile({ ...selectedProfile, name: e.target.value })}
                    className="w-full bg-bg-primary ring-1 ring-border-light rounded-md h-9 px-3 text-text-primary text-[13px] focus:outline-none focus:ring-[3px] focus:ring-accent-primary/45 transition-colors"
                  />
                </div>

                <div>
                  <label className="block text-text-secondary text-[12px] mb-1.5">Description</label>
                  <input
                    type="text"
                    value={selectedProfile.description || ''}
                    onChange={(e) => setSelectedProfile({ ...selectedProfile, description: e.target.value })}
                    className="w-full bg-bg-primary ring-1 ring-border-light rounded-md h-9 px-3 text-text-primary text-[13px] focus:outline-none focus:ring-[3px] focus:ring-accent-primary/45 transition-colors"
                    placeholder="Optional description"
                  />
                </div>

                <div className="border-t border-seam pt-4">
                  <label className="block text-text-secondary text-[12px] mb-1.5">Working Directory</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={selectedProfile.working_directory}
                      onChange={(e) => setSelectedProfile({ ...selectedProfile, working_directory: e.target.value })}
                      className="flex-1 bg-bg-primary ring-1 ring-border-light rounded-md h-9 px-3 text-text-primary text-[13px] focus:outline-none focus:ring-[3px] focus:ring-accent-primary/45 transition-colors"
                      placeholder="C:\path\to\project"
                    />
                    <button
                      onClick={handleBrowseDirectory}
                      className="px-3 h-9 bg-bg-primary ring-1 ring-border-light rounded-md hover:bg-fill-hover transition-colors"
                      title="Browse for directory"
                    >
                      <FolderOpen size={16} className="text-text-secondary" />
                    </button>
                  </div>
                </div>

                <div className="border-t border-seam pt-4">
                  <label className="block text-text-secondary text-[12px] mb-1.5">
                    {specFor(selectedProfile.agent).displayName} Arguments (one per line)
                  </label>
                  <textarea
                    value={(selectedProfile.agent_args?.[selectedProfile.agent] ?? []).join('\n')}
                    onChange={(e) => {
                      const nextArgs = e.target.value.split('\n').filter(Boolean);
                      const nextAgentArgs = {
                        ...(selectedProfile.agent_args ?? {}),
                        [selectedProfile.agent]: nextArgs,
                      };
                      // Mirror the currently-edited agent's args into
                      // claude_args so the legacy field stays consistent
                      // client-side; the backend also enforces this on save.
                      setSelectedProfile({
                        ...selectedProfile,
                        agent_args: nextAgentArgs,
                        claude_args: nextArgs,
                      });
                    }}
                    className="w-full bg-bg-primary ring-1 ring-border-light rounded-md py-2 px-3 text-text-primary text-[13px] focus:outline-none focus:ring-[3px] focus:ring-accent-primary/45 font-mono h-24 resize-none transition-colors"
                    placeholder="--model opus&#10;--verbose"
                  />
                  <p className="text-text-tertiary text-[11px] mt-1">
                    Switch the Agent above to edit args for another agent - each agent keeps its own list.
                  </p>
                </div>

                <div className="border-t border-seam pt-4">
                  <label className="block text-text-secondary text-[12px] mb-1.5">Environment Variables</label>
                  <div className="space-y-1.5">
                    {Object.entries(selectedProfile.env_vars).map(([key, value], index) => (
                      <div key={index} className="flex items-center gap-1.5">
                        <input
                          type="text"
                          value={key}
                          onChange={(e) => {
                            const entries = Object.entries(selectedProfile.env_vars);
                            entries[index] = [e.target.value, value];
                            setSelectedProfile({ ...selectedProfile, env_vars: Object.fromEntries(entries) });
                          }}
                          className="flex-1 bg-bg-primary ring-1 ring-border-light rounded-md h-8 px-2 text-text-primary text-[12px] font-mono focus:outline-none focus:ring-[3px] focus:ring-accent-primary/45 transition-colors"
                          placeholder="KEY"
                        />
                        <span className="text-text-tertiary text-[12px]">=</span>
                        <input
                          type="text"
                          value={value}
                          onChange={(e) => {
                            setSelectedProfile({ ...selectedProfile, env_vars: { ...selectedProfile.env_vars, [key]: e.target.value } });
                          }}
                          className="flex-1 bg-bg-primary ring-1 ring-border-light rounded-md h-8 px-2 text-text-primary text-[12px] font-mono focus:outline-none focus:ring-[3px] focus:ring-accent-primary/45 transition-colors"
                          placeholder="value"
                        />
                        <button
                          onClick={() => {
                            const newVars = { ...selectedProfile.env_vars };
                            delete newVars[key];
                            setSelectedProfile({ ...selectedProfile, env_vars: newVars });
                          }}
                          className="p-1 rounded hover:bg-red-500/10 text-text-tertiary hover:text-red-400 transition-colors flex-shrink-0"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                    <button
                      onClick={() => {
                        setSelectedProfile({ ...selectedProfile, env_vars: { ...selectedProfile.env_vars, '': '' } });
                      }}
                      className="flex items-center gap-1.5 text-text-secondary hover:text-text-primary text-[12px] py-1 hover:bg-fill-hover rounded-md px-2 transition-colors"
                    >
                      <Plus size={13} />
                      Add Variable
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-2 border-t border-seam pt-4">
                  <input
                    type="checkbox"
                    id="is_default"
                    checked={selectedProfile.is_default}
                    onChange={(e) => setSelectedProfile({ ...selectedProfile, is_default: e.target.checked })}
                    className="rounded border-border-light bg-bg-primary text-accent-primary focus:ring-[3px] focus:ring-accent-primary/45"
                  />
                  <label htmlFor="is_default" className="text-text-primary text-[13px]">Set as default profile</label>
                </div>

                <div className="border-t border-seam pt-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="preview_enabled"
                      checked={selectedProfile.preview?.enabled ?? false}
                      onChange={(e) => {
                        const enabled = e.target.checked;
                        const nextPreview: PreviewProfile | null = enabled
                          ? {
                              enabled: true,
                              url_override: selectedProfile.preview?.url_override ?? null,
                              framework_hint: selectedProfile.preview?.framework_hint ?? null,
                            }
                          : null;
                        setSelectedProfile({ ...selectedProfile, preview: nextPreview });
                      }}
                      className="rounded border-border-light bg-bg-primary text-accent-primary focus:ring-[3px] focus:ring-accent-primary/45"
                    />
                    <label htmlFor="preview_enabled" className="text-text-primary text-[13px]">
                      Has GUI preview
                    </label>
                  </div>
                  {selectedProfile.preview?.enabled && (
                    <div>
                      <label className="block text-text-secondary text-[12px] mb-1.5">
                        Preview URL (optional override)
                      </label>
                      <input
                        type="text"
                        value={selectedProfile.preview?.url_override ?? ''}
                        onChange={(e) => {
                          const value = e.target.value;
                          setSelectedProfile({
                            ...selectedProfile,
                            preview: {
                              enabled: true,
                              url_override: value ? value : null,
                              framework_hint: selectedProfile.preview?.framework_hint ?? null,
                            },
                          });
                        }}
                        className="w-full bg-bg-primary ring-1 ring-border-light rounded-md h-9 px-3 text-text-primary text-[13px] focus:outline-none focus:ring-[3px] focus:ring-accent-primary/45 transition-colors"
                        placeholder="http://localhost:3000"
                      />
                    </div>
                  )}
                </div>

                {saveError && (
                  <div className="p-3 rounded-md bg-error/5 ring-1 ring-error/20">
                    <p className="text-error text-[12px]">{saveError}</p>
                  </div>
                )}

                <div className="flex gap-2 pt-4 border-t border-seam">
                  <Button
                    variant="primary"
                    onClick={handleSaveProfile}
                    icon={<Save size={14} />}
                  >
                    Save Profile
                  </Button>

                  {!isCreating && (
                    <Button
                      variant="danger"
                      onClick={() => handleDeleteProfile(selectedProfile.id)}
                      icon={<Trash2 size={14} />}
                    >
                      Delete
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-text-tertiary text-[13px]">
                Select a profile or create a new one
              </div>
            )}
          </div>
        </div>
    </Modal>
  );
}
