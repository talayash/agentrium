import { useState, useEffect, useCallback } from 'react';
import { X, Plus, Trash2, Save, FileText, Settings, Terminal, AlertCircle, Check } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store/appStore';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';

type Tab = 'settings' | 'agents' | 'commands';

export function ClaudeConfigModal() {
  const { closeClaudeConfig } = useAppStore();
  const [activeTab, setActiveTab] = useState<Tab>('settings');

  return (
    <Modal
      onClose={closeClaudeConfig}
      closeOn="doubleClick"
      scrimClassName="bg-black/50 z-50"
      panelClassName="w-full max-w-4xl"
    >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-4">
            <h2 className="text-text-primary text-[14px] font-semibold">Claude Configuration</h2>
            <div className="flex gap-1">
              {([
                { key: 'settings', label: 'Settings', icon: Settings },
                { key: 'agents', label: 'Agents', icon: FileText },
                { key: 'commands', label: 'Commands', icon: Terminal },
              ] as const).map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  onClick={() => setActiveTab(key)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors ${
                    activeTab === key
                      ? 'bg-accent-primary/10 text-accent-primary ring-1 ring-accent-primary/30'
                      : 'text-text-secondary hover:text-text-primary hover:bg-white/[0.04]'
                  }`}
                >
                  <Icon size={13} />
                  {label}
                </button>
              ))}
            </div>
          </div>
          <button
            onClick={closeClaudeConfig}
            className="p-1 rounded hover:bg-white/[0.06] text-text-tertiary transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="h-[560px]">
          {activeTab === 'settings' && <SettingsTab />}
          {activeTab === 'agents' && <FileListTab type="agents" />}
          {activeTab === 'commands' && <FileListTab type="commands" />}
        </div>
    </Modal>
  );
}

// --- Settings Tab: JSON editor for ~/.claude/settings.json ---

function SettingsTab() {
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  // Set when the settings file can't be READ (permission/IO/too-large). While
  // set, we render an error panel instead of the editor so a Save can never
  // overwrite a real-but-unreadable settings.json with empty content. A missing
  // file is NOT an error - the backend returns "{}" for it via the success path.
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const raw = await invoke<string>('read_claude_settings');
      let formatted: string;
      try {
        // Pretty-print when it parses.
        formatted = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        // File exists but isn't valid JSON (hand-edited typo, etc.). Show the
        // raw content verbatim so the user can fix it - never replace it with
        // "{}". Save re-validates the JSON before writing.
        formatted = raw;
      }
      setContent(formatted);
      setOriginalContent(formatted);
    } catch (err) {
      setLoadError(String(err));
    }
    setLoading(false);
  };

  const handleSave = async () => {
    setStatus('saving');
    setError('');
    try {
      // Validate JSON before sending
      JSON.parse(content);
      await invoke('write_claude_settings', { content });
      setOriginalContent(content);
      setStatus('saved');
      setTimeout(() => setStatus('idle'), 2000);
    } catch (err) {
      setStatus('error');
      setError(String(err));
    }
  };

  const hasChanges = content !== originalContent;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (hasChanges) handleSave();
    }
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-text-tertiary text-[13px]">
        Loading settings...
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 px-8 text-center">
        <AlertCircle size={28} className="text-error" />
        <p className="text-text-primary text-[13px] font-medium">
          Couldn't read ~/.claude/settings.json
        </p>
        <p className="text-text-tertiary text-[12px] max-w-md break-words">{loadError}</p>
        <p className="text-text-tertiary text-[11px] max-w-md">
          Editing is disabled so your existing settings aren't overwritten. Fix the
          file permissions and try again.
        </p>
        <Button variant="secondary" size="sm" onClick={loadSettings} className="mt-1">
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
        <div className="flex items-center gap-2">
          <p className="text-text-secondary text-[12px]">~/.claude/settings.json</p>
          {hasChanges && (
            <span className="text-[11px] text-warning bg-warning/10 px-1.5 py-0.5 rounded">unsaved</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {status === 'error' && (
            <div className="flex items-center gap-1.5 text-error text-[11px]">
              <AlertCircle size={12} />
              <span className="max-w-[200px] truncate">{error}</span>
            </div>
          )}
          {status === 'saved' && (
            <div className="flex items-center gap-1.5 text-success text-[11px]">
              <Check size={12} />
              Saved
            </div>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={handleSave}
            disabled={!hasChanges || status === 'saving'}
            loading={status === 'saving'}
            icon={<Save size={12} />}
            className="px-3"
          >
            Save
          </Button>
        </div>
      </div>
      <div className="flex-1 p-4 overflow-hidden">
        <textarea
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
            setStatus('idle');
            setError('');
          }}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          className="w-full h-full bg-bg-primary ring-1 ring-border-light rounded-md p-3 text-text-primary text-[13px] font-mono resize-none focus:outline-none focus:ring-accent-primary transition-colors leading-relaxed"
          placeholder='{ }'
        />
      </div>
    </div>
  );
}

// --- File List Tab: Agents or Commands ---

function FileListTab({ type }: { type: 'agents' | 'commands' }) {
  const [files, setFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const listCommand = type === 'agents' ? 'list_claude_agents' : 'list_claude_commands';
  const readCommand = type === 'agents' ? 'read_claude_agent' : 'read_claude_command';
  const writeCommand = type === 'agents' ? 'write_claude_agent' : 'write_claude_command';
  const deleteCommand = type === 'agents' ? 'delete_claude_agent' : 'delete_claude_command';

  const loadFiles = useCallback(async () => {
    setLoading(true);
    try {
      const names = await invoke<string[]>(listCommand);
      setFiles(names);
    } catch {
      setFiles([]);
    }
    setLoading(false);
  }, [listCommand]);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  const handleSelectFile = async (name: string) => {
    try {
      const fileContent = await invoke<string>(readCommand, { name });
      setSelectedFile(name);
      setContent(fileContent);
      setOriginalContent(fileContent);
      setIsCreating(false);
      setStatus('idle');
      setError('');
    } catch (err) {
      setError(String(err));
    }
  };

  const handleCreate = () => {
    setIsCreating(true);
    setSelectedFile(null);
    setNewFileName(type === 'agents' ? 'new-agent.md' : 'new-command.md');
    setContent(type === 'agents' ? getAgentTemplate() : getCommandTemplate());
    setOriginalContent('');
    setStatus('idle');
    setError('');
  };

  const handleSave = async () => {
    const name = isCreating ? newFileName : selectedFile;
    if (!name) return;

    setStatus('saving');
    setError('');
    try {
      await invoke(writeCommand, { name, content });
      setOriginalContent(content);
      setStatus('saved');
      if (isCreating) {
        setIsCreating(false);
        setSelectedFile(name);
      }
      await loadFiles();
      setTimeout(() => setStatus('idle'), 2000);
    } catch (err) {
      setStatus('error');
      setError(String(err));
    }
  };

  const handleDelete = async (name: string) => {
    try {
      await invoke(deleteCommand, { name });
      if (selectedFile === name) {
        setSelectedFile(null);
        setContent('');
        setOriginalContent('');
      }
      await loadFiles();
    } catch (err) {
      setError(String(err));
    }
  };

  const hasChanges = content !== originalContent;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (hasChanges || isCreating) handleSave();
    }
  };

  const label = type === 'agents' ? 'Agent' : 'Command';
  const dirPath = type === 'agents' ? '~/.claude/agents/' : '~/.claude/commands/';

  return (
    <div className="h-full flex">
      {/* File List */}
      <div className="w-56 border-r border-border p-3 flex flex-col">
        <Button
          variant="primary"
          size="sm"
          onClick={handleCreate}
          icon={<Plus size={14} />}
          className="w-full h-auto py-2 mb-3"
        >
          New {label}
        </Button>

        <p className="text-text-tertiary text-[10px] mb-2 px-1">{dirPath}</p>

        <div className="flex-1 overflow-y-auto space-y-0.5">
          {loading ? (
            <p className="text-text-tertiary text-[12px] text-center py-4">Loading...</p>
          ) : files.length === 0 ? (
            <p className="text-text-tertiary text-[12px] text-center py-4">
              No {type} yet
            </p>
          ) : (
            files.map((name) => (
              <div
                key={name}
                onClick={() => handleSelectFile(name)}
                className={`group flex items-center justify-between p-2 rounded-md cursor-pointer transition-colors ${
                  selectedFile === name
                    ? 'bg-accent-primary/10 ring-1 ring-accent-primary/30'
                    : 'hover:bg-white/[0.04]'
                }`}
              >
                <p className="text-text-primary text-[12px] font-medium truncate flex-1">{name}</p>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(name);
                  }}
                  className="p-0.5 rounded hover:bg-red-500/10 text-text-tertiary hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                  title={`Delete ${name}`}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 flex flex-col">
        {selectedFile || isCreating ? (
          <>
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
              <div className="flex items-center gap-2">
                {isCreating ? (
                  <input
                    type="text"
                    value={newFileName}
                    onChange={(e) => setNewFileName(e.target.value)}
                    className="bg-bg-primary ring-1 ring-border-light rounded-md h-7 px-2 text-text-primary text-[12px] font-mono focus:outline-none focus:ring-accent-primary transition-colors w-48"
                    placeholder="filename.md"
                    autoFocus
                  />
                ) : (
                  <p className="text-text-secondary text-[12px] font-mono">{selectedFile}</p>
                )}
                {hasChanges && (
                  <span className="text-[11px] text-warning bg-warning/10 px-1.5 py-0.5 rounded">unsaved</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {status === 'error' && (
                  <div className="flex items-center gap-1.5 text-error text-[11px]">
                    <AlertCircle size={12} />
                    <span className="max-w-[200px] truncate">{error}</span>
                  </div>
                )}
                {status === 'saved' && (
                  <div className="flex items-center gap-1.5 text-success text-[11px]">
                    <Check size={12} />
                    Saved
                  </div>
                )}
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleSave}
                  disabled={(!hasChanges && !isCreating) || status === 'saving'}
                  loading={status === 'saving'}
                  icon={<Save size={12} />}
                  className="px-3"
                >
                  Save
                </Button>
              </div>
            </div>
            <div className="flex-1 p-4 overflow-hidden">
              <textarea
                value={content}
                onChange={(e) => {
                  setContent(e.target.value);
                  setStatus('idle');
                  setError('');
                }}
                onKeyDown={handleKeyDown}
                spellCheck={false}
                className="w-full h-full bg-bg-primary ring-1 ring-border-light rounded-md p-3 text-text-primary text-[13px] font-mono resize-none focus:outline-none focus:ring-accent-primary transition-colors leading-relaxed"
                placeholder={`Enter ${type === 'agents' ? 'agent' : 'command'} content...`}
              />
            </div>
          </>
        ) : (
          <div className="h-full flex items-center justify-center text-text-tertiary text-[13px]">
            Select a file or create a new {type === 'agents' ? 'agent' : 'command'}
          </div>
        )}
      </div>
    </div>
  );
}

function getAgentTemplate(): string {
  return `# Agent Name

Description of what this agent does.

## Instructions

- Instruction 1
- Instruction 2
`;
}

function getCommandTemplate(): string {
  return `# Command Name

Description of this command.

## Steps

$ARGUMENTS
`;
}
