import { useState, useEffect } from 'react';
import { Plus, Trash2, Play, Save, FileText } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';
import { toast } from '../store/toastStore';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { ListRow } from './ui/ListRow';
import { EmptyState } from './ui/EmptyState';

interface Snippet {
  id: string;
  title: string;
  content: string;
  category: string;
  created_at: string;
}

const DEFAULT_CATEGORIES = ['General', 'Prompts', 'Commands', 'Templates'];

export function SnippetsModal() {
  const { closeSnippetsModal } = useAppStore();
  const { activeTerminalId, writeToTerminal } = useTerminalStore();

  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [selectedSnippet, setSelectedSnippet] = useState<Snippet | null>(null);
  const [filterCategory, setFilterCategory] = useState<string>('All');
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editCategory, setEditCategory] = useState('General');

  useEffect(() => {
    loadSnippets();
  }, []);

  const loadSnippets = async () => {
    try {
      const loaded = await invoke<Snippet[]>('get_snippets');
      setSnippets(loaded);
    } catch (err) {
      console.error('Failed to load snippets:', err);
    }
  };

  const categories = ['All', ...Array.from(new Set([...DEFAULT_CATEGORIES, ...snippets.map(s => s.category)]))];
  const filteredSnippets = filterCategory === 'All'
    ? snippets
    : snippets.filter(s => s.category === filterCategory);

  const handleNew = () => {
    setSelectedSnippet(null);
    setEditing(true);
    setEditTitle('');
    setEditContent('');
    setEditCategory('General');
  };

  const handleSelect = (snippet: Snippet) => {
    setSelectedSnippet(snippet);
    setEditing(false);
    setEditTitle(snippet.title);
    setEditContent(snippet.content);
    setEditCategory(snippet.category);
  };

  const handleEdit = () => {
    if (selectedSnippet) {
      setEditing(true);
      setEditTitle(selectedSnippet.title);
      setEditContent(selectedSnippet.content);
      setEditCategory(selectedSnippet.category);
    }
  };

  const handleSave = async () => {
    if (!editTitle.trim() || !editContent.trim()) return;
    try {
      const snippet: Snippet = {
        id: selectedSnippet?.id || crypto.randomUUID(),
        title: editTitle.trim(),
        content: editContent,
        category: editCategory,
        created_at: selectedSnippet?.created_at || new Date().toISOString(),
      };
      await invoke('save_snippet', { snippet });
      await loadSnippets();
      setSelectedSnippet(snippet);
      setEditing(false);
      toast.success('Snippet Saved', `"${snippet.title}" has been saved.`);
    } catch (err) {
      console.error('Failed to save snippet:', err);
      toast.error('Save Failed', 'Could not save snippet.');
    }
  };

  const handleDelete = async (snippet: Snippet) => {
    try {
      const title = snippet.title;
      await invoke('delete_snippet', { id: snippet.id });
      if (selectedSnippet?.id === snippet.id) {
        setSelectedSnippet(null);
        setEditing(false);
      }
      await loadSnippets();
      toast.success('Snippet Deleted', `"${title}" has been removed.`);
    } catch (err) {
      console.error('Failed to delete snippet:', err);
      toast.error('Delete Failed', 'Could not delete snippet.');
    }
  };

  const handleInsert = async () => {
    const content = editing ? editContent : selectedSnippet?.content;
    if (!content || !activeTerminalId) return;
    await writeToTerminal(activeTerminalId, content);
    toast.success('Snippet Inserted', 'Content sent to terminal.');
    closeSnippetsModal();
  };

  return (
    <Modal
      onClose={closeSnippetsModal}
      closeOn="doubleClick"
      scrimClassName="bg-black/50 z-50"
      panelClassName="w-full max-w-3xl"
      showHeader
      title="Snippets"
      icon={<FileText size={16} className="text-text-secondary" />}
    >
        {/* Content */}
        <div className="flex h-[450px]">
          {/* Left: Snippet List */}
          <div className="w-64 border-r border-border flex flex-col">
            {/* Category Filter */}
            <div className="p-2 border-b border-border flex flex-wrap gap-1">
              {categories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setFilterCategory(cat)}
                  className={`px-2 py-0.5 rounded-full text-[11px] transition-colors ${
                    filterCategory === cat
                      ? 'bg-accent-primary/20 text-accent-primary'
                      : 'bg-bg-primary text-text-tertiary hover:text-text-secondary'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>

            {/* New Button */}
            <div className="p-2 border-b border-border">
              <Button
                variant="primary"
                size="sm"
                onClick={handleNew}
                icon={<Plus size={14} />}
                className="w-full"
              >
                New Snippet
              </Button>
            </div>

            {/* Snippet List */}
            <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
              {filteredSnippets.map((snippet) => (
                <ListRow
                  key={snippet.id}
                  selected={selectedSnippet?.id === snippet.id}
                  onClick={() => handleSelect(snippet)}
                  className="group items-start py-1.5"
                  trailing={
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(snippet);
                      }}
                      className="p-0.5 rounded hover:bg-red-500/10 text-text-tertiary hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                    >
                      <Trash2 size={12} />
                    </button>
                  }
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-text-primary text-[12px] font-medium truncate">{snippet.title}</p>
                    <p className="text-text-tertiary text-[11px] truncate mt-0.5">{snippet.category}</p>
                  </div>
                </ListRow>
              ))}

              {filteredSnippets.length === 0 && (
                <EmptyState
                  icon={<FileText size={20} strokeWidth={1.75} />}
                  title="No snippets yet"
                  description="Save reusable Claude prompts, commands, or templates here."
                  compact
                />
              )}
            </div>
          </div>

          {/* Right: Editor / Preview */}
          <div className="flex-1 flex flex-col">
            {editing ? (
              <>
                <div className="p-3 space-y-2 border-b border-border">
                  <input
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    placeholder="Snippet title..."
                    className="w-full bg-bg-primary ring-1 ring-border-light rounded-md h-8 px-3 text-text-primary text-[13px] focus:outline-none focus:ring-accent-primary transition-colors"
                  />
                  <select
                    value={editCategory}
                    onChange={(e) => setEditCategory(e.target.value)}
                    className="bg-bg-primary ring-1 ring-border-light rounded-md h-8 px-2 text-text-primary text-[12px] focus:outline-none focus:ring-accent-primary transition-colors"
                  >
                    {DEFAULT_CATEGORIES.map((cat) => (
                      <option key={cat} value={cat}>{cat}</option>
                    ))}
                  </select>
                </div>
                <div className="flex-1 p-3">
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    placeholder="Snippet content..."
                    className="w-full h-full bg-bg-primary ring-1 ring-border-light rounded-md py-2 px-3 text-text-primary text-[13px] font-mono focus:outline-none focus:ring-accent-primary resize-none transition-colors"
                  />
                </div>
                <div className="flex gap-2 p-3 border-t border-border">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleSave}
                    disabled={!editTitle.trim() || !editContent.trim()}
                    icon={<Save size={14} />}
                    className="h-8"
                  >
                    Save
                  </Button>
                  {activeTerminalId && (
                    <button
                      onClick={handleInsert}
                      disabled={!editContent.trim()}
                      className="flex items-center gap-2 bg-success/20 hover:bg-success/30 text-success disabled:opacity-50 h-8 px-4 rounded-md text-[12px] font-medium transition-colors"
                    >
                      <Play size={14} />
                      Insert into Terminal
                    </button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => { setEditing(false); if (!selectedSnippet) { setEditTitle(''); setEditContent(''); } }}
                    className="h-8"
                  >
                    Cancel
                  </Button>
                </div>
              </>
            ) : selectedSnippet ? (
              <>
                <div className="p-3 border-b border-border">
                  <h3 className="text-text-primary text-[14px] font-medium">{selectedSnippet.title}</h3>
                  <p className="text-text-tertiary text-[11px] mt-0.5">{selectedSnippet.category}</p>
                </div>
                <div className="flex-1 overflow-auto p-3">
                  <pre className="text-text-secondary text-[12px] font-mono whitespace-pre-wrap break-words">
                    {selectedSnippet.content}
                  </pre>
                </div>
                <div className="flex gap-2 p-3 border-t border-border">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleEdit}
                    className="h-8"
                  >
                    Edit
                  </Button>
                  {activeTerminalId && (
                    <button
                      onClick={handleInsert}
                      className="flex items-center gap-2 bg-success/20 hover:bg-success/30 text-success h-8 px-4 rounded-md text-[12px] font-medium transition-colors"
                    >
                      <Play size={14} />
                      Insert into Terminal
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div className="h-full flex items-center justify-center text-text-tertiary text-[13px]">
                Select a snippet or create a new one
              </div>
            )}
          </div>
        </div>
    </Modal>
  );
}
