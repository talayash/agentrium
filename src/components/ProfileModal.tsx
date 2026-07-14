import { useState, useEffect } from 'react';
import { X, Plus, Trash2, Save, FolderOpen, User } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useAppStore } from '../store/appStore';
import { toast } from '../store/toastStore';
import { v4 as uuidv4 } from 'uuid';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';
import { ListRow } from './ui/ListRow';
import { EmptyState } from './ui/EmptyState';

interface ConfigProfile {
  id: string;
  name: string;
  description: string | null;
  working_directory: string;
  claude_args: string[];
  env_vars: Record<string, string>;
  is_default: boolean;
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
      console.error('Failed to load profiles:', err);
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
      console.error('Failed to save profile:', err);
      setSaveError(String(err));
      toast.error('Save Failed', String(err));
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
      console.error('Failed to open directory picker:', error);
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
      console.error('Failed to delete profile:', err);
      setSaveError(String(err));
      toast.error('Delete Failed', String(err));
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
        <div className="flex items-center justify-between px-4 h-11 bg-elevation-2 border-b border-[var(--ij-divider-soft)]">
          <h2 className="text-text-primary text-[14px] font-semibold">Configuration Profiles</h2>
          <button
            onClick={closeProfileModal}
            className="p-1 rounded hover:bg-white/[0.06] text-text-tertiary transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="flex h-[500px]">
          {/* Profile List */}
          <div className="w-64 border-r border-[var(--ij-divider-soft)] bg-black/20 p-3 flex flex-col">
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
                  <label className="block text-text-secondary text-[12px] mb-1.5">Name</label>
                  <input
                    type="text"
                    value={selectedProfile.name}
                    onChange={(e) => setSelectedProfile({ ...selectedProfile, name: e.target.value })}
                    className="w-full bg-bg-primary ring-1 ring-border-light rounded-md h-9 px-3 text-text-primary text-[13px] focus:outline-none focus:ring-accent-primary transition-colors"
                  />
                </div>

                <div>
                  <label className="block text-text-secondary text-[12px] mb-1.5">Description</label>
                  <input
                    type="text"
                    value={selectedProfile.description || ''}
                    onChange={(e) => setSelectedProfile({ ...selectedProfile, description: e.target.value })}
                    className="w-full bg-bg-primary ring-1 ring-border-light rounded-md h-9 px-3 text-text-primary text-[13px] focus:outline-none focus:ring-accent-primary transition-colors"
                    placeholder="Optional description"
                  />
                </div>

                <div className="border-t border-[var(--ij-divider-soft)] pt-4">
                  <label className="block text-text-secondary text-[12px] mb-1.5">Working Directory</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={selectedProfile.working_directory}
                      onChange={(e) => setSelectedProfile({ ...selectedProfile, working_directory: e.target.value })}
                      className="flex-1 bg-bg-primary ring-1 ring-border-light rounded-md h-9 px-3 text-text-primary text-[13px] focus:outline-none focus:ring-accent-primary transition-colors"
                      placeholder="C:\path\to\project"
                    />
                    <button
                      onClick={handleBrowseDirectory}
                      className="px-3 h-9 bg-bg-primary ring-1 ring-border-light rounded-md hover:bg-white/[0.04] transition-colors"
                      title="Browse for directory"
                    >
                      <FolderOpen size={16} className="text-text-secondary" />
                    </button>
                  </div>
                </div>

                <div className="border-t border-[var(--ij-divider-soft)] pt-4">
                  <label className="block text-text-secondary text-[12px] mb-1.5">Claude Arguments (one per line)</label>
                  <textarea
                    value={selectedProfile.claude_args.join('\n')}
                    onChange={(e) => setSelectedProfile({ ...selectedProfile, claude_args: e.target.value.split('\n').filter(Boolean) })}
                    className="w-full bg-bg-primary ring-1 ring-border-light rounded-md py-2 px-3 text-text-primary text-[13px] focus:outline-none focus:ring-accent-primary font-mono h-24 resize-none transition-colors"
                    placeholder="--model opus&#10;--verbose"
                  />
                </div>

                <div className="border-t border-[var(--ij-divider-soft)] pt-4">
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
                          className="flex-1 bg-bg-primary ring-1 ring-border-light rounded-md h-8 px-2 text-text-primary text-[12px] font-mono focus:outline-none focus:ring-accent-primary transition-colors"
                          placeholder="KEY"
                        />
                        <span className="text-text-tertiary text-[12px]">=</span>
                        <input
                          type="text"
                          value={value}
                          onChange={(e) => {
                            setSelectedProfile({ ...selectedProfile, env_vars: { ...selectedProfile.env_vars, [key]: e.target.value } });
                          }}
                          className="flex-1 bg-bg-primary ring-1 ring-border-light rounded-md h-8 px-2 text-text-primary text-[12px] font-mono focus:outline-none focus:ring-accent-primary transition-colors"
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
                      className="flex items-center gap-1.5 text-text-secondary hover:text-text-primary text-[12px] py-1 hover:bg-white/[0.04] rounded-md px-2 transition-colors"
                    >
                      <Plus size={13} />
                      Add Variable
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-2 border-t border-[var(--ij-divider-soft)] pt-4">
                  <input
                    type="checkbox"
                    id="is_default"
                    checked={selectedProfile.is_default}
                    onChange={(e) => setSelectedProfile({ ...selectedProfile, is_default: e.target.checked })}
                    className="rounded border-border-light bg-bg-primary text-accent-primary focus:ring-accent-primary"
                  />
                  <label htmlFor="is_default" className="text-text-primary text-[13px]">Set as default profile</label>
                </div>

                {saveError && (
                  <div className="p-3 rounded-md bg-error/5 ring-1 ring-error/20">
                    <p className="text-error text-[12px]">{saveError}</p>
                  </div>
                )}

                <div className="flex gap-2 pt-4 border-t border-[var(--ij-divider-soft)]">
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
