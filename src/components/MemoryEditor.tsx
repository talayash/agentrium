import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { X, FileText, Brain, BookOpen, Save, RotateCw, ChevronRight } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store/appStore';
import { toast } from '../store/toastStore';

interface ClaudeMdInfo {
  path: string;
  scope: string;
  projectName: string | null;
}

interface MemoryFileInfo {
  path: string;
  name: string;
  project: string;
  size: number;
}

type Tab = 'claudemd' | 'memory' | 'rules';

export function MemoryEditor() {
  const { closeMemoryEditor } = useAppStore();
  const [activeTab, setActiveTab] = useState<Tab>('claudemd');

  // CLAUDE.md state
  const [claudeMdFiles, setClaudeMdFiles] = useState<ClaudeMdInfo[]>([]);
  const [selectedClaudeMd, setSelectedClaudeMd] = useState<ClaudeMdInfo | null>(null);
  const [claudeMdContent, setClaudeMdContent] = useState('');
  const [claudeMdDirty, setClaudeMdDirty] = useState(false);

  // Memory state
  const [memoryFiles, setMemoryFiles] = useState<MemoryFileInfo[]>([]);
  const [selectedMemory, setSelectedMemory] = useState<MemoryFileInfo | null>(null);
  const [memoryContent, setMemoryContent] = useState('');
  const [memoryDirty, setMemoryDirty] = useState(false);

  // Rules state
  const [ruleFiles] = useState<MemoryFileInfo[]>([]);
  const [selectedRule, setSelectedRule] = useState<MemoryFileInfo | null>(null);
  const [ruleContent, setRuleContent] = useState('');
  const [ruleDirty, setRuleDirty] = useState(false);

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadClaudeMdFiles();
    loadMemoryFiles();
  }, []);

  const loadClaudeMdFiles = async () => {
    try {
      const files = await invoke<ClaudeMdInfo[]>('list_claude_md_files');
      setClaudeMdFiles(files);
    } catch (err) {
      console.error('Failed to load CLAUDE.md files:', err);
    }
  };

  const loadMemoryFiles = async () => {
    try {
      const files = await invoke<MemoryFileInfo[]>('list_memory_files', {});
      setMemoryFiles(files);
    } catch (err) {
      console.error('Failed to load memory files:', err);
    }
  };

  const handleSelectClaudeMd = async (file: ClaudeMdInfo) => {
    setSelectedClaudeMd(file);
    setLoading(true);
    setError(null);
    try {
      const content = await invoke<string>('read_memory_file', { path: file.path });
      setClaudeMdContent(content);
      setClaudeMdDirty(false);
    } catch (err) {
      setError(String(err));
      setClaudeMdContent('');
    } finally {
      setLoading(false);
    }
  };

  const handleSaveClaudeMd = async () => {
    if (!selectedClaudeMd) return;
    setSaving(true);
    setError(null);
    try {
      await invoke('write_memory_file', { path: selectedClaudeMd.path, content: claudeMdContent });
      setClaudeMdDirty(false);
      toast.success('File Saved', selectedClaudeMd.path.split(/[/\\]/).pop() || 'CLAUDE.md');
    } catch (err) {
      setError(String(err));
      toast.error('Save Failed', String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleSelectMemory = async (file: MemoryFileInfo) => {
    setSelectedMemory(file);
    setLoading(true);
    setError(null);
    try {
      const content = await invoke<string>('read_memory_file', { path: file.path });
      setMemoryContent(content);
      setMemoryDirty(false);
    } catch (err) {
      setError(String(err));
      setMemoryContent('');
    } finally {
      setLoading(false);
    }
  };

  const handleSaveMemory = async () => {
    if (!selectedMemory) return;
    setSaving(true);
    setError(null);
    try {
      await invoke('write_memory_file', { path: selectedMemory.path, content: memoryContent });
      setMemoryDirty(false);
      toast.success('File Saved', selectedMemory.path.split(/[/\\]/).pop() || 'Memory file');
    } catch (err) {
      setError(String(err));
      toast.error('Save Failed', String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleSelectRule = async (file: MemoryFileInfo) => {
    setSelectedRule(file);
    setLoading(true);
    setError(null);
    try {
      const content = await invoke<string>('read_memory_file', { path: file.path });
      setRuleContent(content);
      setRuleDirty(false);
    } catch (err) {
      setError(String(err));
      setRuleContent('');
    } finally {
      setLoading(false);
    }
  };

  const handleSaveRule = async () => {
    if (!selectedRule) return;
    setSaving(true);
    setError(null);
    try {
      await invoke('write_memory_file', { path: selectedRule.path, content: ruleContent });
      setRuleDirty(false);
      toast.success('File Saved', selectedRule.path.split(/[/\\]/).pop() || 'Rule file');
    } catch (err) {
      setError(String(err));
      toast.error('Save Failed', String(err));
    } finally {
      setSaving(false);
    }
  };

  // Group memory files by project
  const memoryByProject = memoryFiles.reduce<Record<string, MemoryFileInfo[]>>((acc, f) => {
    if (!acc[f.project]) acc[f.project] = [];
    acc[f.project].push(f);
    return acc;
  }, {});

  const tabs: { key: Tab; label: string; icon: typeof FileText }[] = [
    { key: 'claudemd', label: 'CLAUDE.md', icon: FileText },
    { key: 'memory', label: 'Auto-Memory', icon: Brain },
    { key: 'rules', label: 'Rules', icon: BookOpen },
  ];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onDoubleClick={closeMemoryEditor}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.98 }}
        transition={{ duration: 0.15 }}
        onDoubleClick={(e) => e.stopPropagation()}
        className="bg-bg-elevated ring-1 ring-white/[0.08] rounded-lg w-full max-w-3xl overflow-hidden flex flex-col"
        style={{ height: '600px' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Brain size={16} className="text-accent-primary" />
            <h2 className="text-text-primary text-[14px] font-semibold">Memory Editor</h2>
            <span className="text-text-tertiary text-[11px]">F8</span>
          </div>
          <button
            onClick={closeMemoryEditor}
            className="p-1 rounded hover:bg-white/[0.06] text-text-tertiary transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-[12px] font-medium border-b-2 transition-colors ${
                activeTab === tab.key
                  ? 'border-accent-primary text-accent-primary'
                  : 'border-transparent text-text-secondary hover:text-text-primary'
              }`}
            >
              <tab.icon size={13} />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 flex overflow-hidden">
          {activeTab === 'claudemd' && (
            <>
              {/* File List */}
              <div className="w-48 border-r border-border overflow-y-auto p-2 flex-shrink-0">
                {claudeMdFiles.length === 0 ? (
                  <p className="text-text-tertiary text-[11px] text-center py-4">No CLAUDE.md files found</p>
                ) : (
                  claudeMdFiles.map((file) => (
                    <button
                      key={file.path}
                      onClick={() => handleSelectClaudeMd(file)}
                      className={`w-full text-left p-2 rounded-md text-[12px] mb-0.5 transition-colors ${
                        selectedClaudeMd?.path === file.path
                          ? 'bg-accent-primary/10 text-accent-primary'
                          : 'text-text-primary hover:bg-white/[0.04]'
                      }`}
                    >
                      <div className="flex items-center gap-1">
                        <FileText size={12} className="flex-shrink-0" />
                        <span className="truncate">
                          {file.scope === 'global' ? 'Global' : file.projectName || 'Project'}
                        </span>
                      </div>
                      <span className="text-text-tertiary text-[10px] capitalize">{file.scope}</span>
                    </button>
                  ))
                )}
              </div>

              {/* Editor */}
              <div className="flex-1 flex flex-col">
                {selectedClaudeMd ? (
                  <>
                    <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                      <span className="text-text-secondary text-[11px] truncate">{selectedClaudeMd.path}</span>
                      <button
                        onClick={handleSaveClaudeMd}
                        disabled={!claudeMdDirty || saving}
                        className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] bg-accent-primary/10 text-accent-primary hover:bg-accent-primary/20 disabled:opacity-40 transition-colors"
                      >
                        <Save size={11} />
                        {saving ? 'Saving...' : 'Save'}
                      </button>
                    </div>
                    {loading ? (
                      <div className="flex-1 flex items-center justify-center">
                        <RotateCw size={16} className="text-text-tertiary animate-spin" />
                      </div>
                    ) : (
                      <textarea
                        value={claudeMdContent}
                        onChange={(e) => { setClaudeMdContent(e.target.value); setClaudeMdDirty(true); }}
                        className="flex-1 bg-bg-primary p-3 text-text-primary text-[12px] font-mono resize-none focus:outline-none"
                        spellCheck={false}
                      />
                    )}
                  </>
                ) : (
                  <div className="flex-1 flex items-center justify-center text-text-tertiary text-[12px]">
                    Select a file to edit
                  </div>
                )}
              </div>
            </>
          )}

          {activeTab === 'memory' && (
            <>
              {/* File List */}
              <div className="w-52 border-r border-border overflow-y-auto p-2 flex-shrink-0">
                {Object.keys(memoryByProject).length === 0 ? (
                  <p className="text-text-tertiary text-[11px] text-center py-4">No memory files found</p>
                ) : (
                  Object.entries(memoryByProject).map(([project, files]) => (
                    <div key={project} className="mb-2">
                      <div className="flex items-center gap-1 px-2 py-1 text-text-secondary text-[10px] font-medium uppercase tracking-wider">
                        <ChevronRight size={10} />
                        <span className="truncate">{project}</span>
                      </div>
                      {files.map((file) => (
                        <button
                          key={file.path}
                          onClick={() => handleSelectMemory(file)}
                          className={`w-full text-left p-2 rounded-md text-[12px] mb-0.5 transition-colors ${
                            selectedMemory?.path === file.path
                              ? 'bg-accent-primary/10 text-accent-primary'
                              : 'text-text-primary hover:bg-white/[0.04]'
                          }`}
                        >
                          <div className="flex items-center gap-1">
                            <Brain size={12} className="flex-shrink-0" />
                            <span className="truncate">{file.name}</span>
                          </div>
                          <span className="text-text-tertiary text-[10px]">
                            {file.size > 1024 ? `${(file.size / 1024).toFixed(1)}KB` : `${file.size}B`}
                          </span>
                        </button>
                      ))}
                    </div>
                  ))
                )}
              </div>

              {/* Editor */}
              <div className="flex-1 flex flex-col">
                {selectedMemory ? (
                  <>
                    <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                      <span className="text-text-secondary text-[11px] truncate">{selectedMemory.name}</span>
                      <button
                        onClick={handleSaveMemory}
                        disabled={!memoryDirty || saving}
                        className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] bg-accent-primary/10 text-accent-primary hover:bg-accent-primary/20 disabled:opacity-40 transition-colors"
                      >
                        <Save size={11} />
                        {saving ? 'Saving...' : 'Save'}
                      </button>
                    </div>
                    {loading ? (
                      <div className="flex-1 flex items-center justify-center">
                        <RotateCw size={16} className="text-text-tertiary animate-spin" />
                      </div>
                    ) : (
                      <textarea
                        value={memoryContent}
                        onChange={(e) => { setMemoryContent(e.target.value); setMemoryDirty(true); }}
                        className="flex-1 bg-bg-primary p-3 text-text-primary text-[12px] font-mono resize-none focus:outline-none"
                        spellCheck={false}
                      />
                    )}
                  </>
                ) : (
                  <div className="flex-1 flex items-center justify-center text-text-tertiary text-[12px]">
                    Select a memory file to view/edit
                  </div>
                )}
              </div>
            </>
          )}

          {activeTab === 'rules' && (
            <>
              <div className="w-48 border-r border-border overflow-y-auto p-2 flex-shrink-0">
                {ruleFiles.length === 0 ? (
                  <p className="text-text-tertiary text-[11px] text-center py-4">No rule files found</p>
                ) : (
                  ruleFiles.map((file) => (
                    <button
                      key={file.path}
                      onClick={() => handleSelectRule(file)}
                      className={`w-full text-left p-2 rounded-md text-[12px] mb-0.5 transition-colors ${
                        selectedRule?.path === file.path
                          ? 'bg-accent-primary/10 text-accent-primary'
                          : 'text-text-primary hover:bg-white/[0.04]'
                      }`}
                    >
                      <div className="flex items-center gap-1">
                        <BookOpen size={12} className="flex-shrink-0" />
                        <span className="truncate">{file.name}</span>
                      </div>
                    </button>
                  ))
                )}
              </div>

              <div className="flex-1 flex flex-col">
                {selectedRule ? (
                  <>
                    <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                      <span className="text-text-secondary text-[11px] truncate">{selectedRule.name}</span>
                      <button
                        onClick={handleSaveRule}
                        disabled={!ruleDirty || saving}
                        className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] bg-accent-primary/10 text-accent-primary hover:bg-accent-primary/20 disabled:opacity-40 transition-colors"
                      >
                        <Save size={11} />
                        {saving ? 'Saving...' : 'Save'}
                      </button>
                    </div>
                    {loading ? (
                      <div className="flex-1 flex items-center justify-center">
                        <RotateCw size={16} className="text-text-tertiary animate-spin" />
                      </div>
                    ) : (
                      <textarea
                        value={ruleContent}
                        onChange={(e) => { setRuleContent(e.target.value); setRuleDirty(true); }}
                        className="flex-1 bg-bg-primary p-3 text-text-primary text-[12px] font-mono resize-none focus:outline-none"
                        spellCheck={false}
                      />
                    )}
                  </>
                ) : (
                  <div className="flex-1 flex items-center justify-center text-text-tertiary text-[12px]">
                    Select a rule file to view/edit
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Error display */}
        {error && (
          <div className="px-4 py-2 border-t border-border">
            <p className="text-error text-[11px]">{error}</p>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
