import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import Editor, { type OnMount } from '@monaco-editor/react';
import type { IRange } from 'monaco-editor';
import {
  X, Send, CornerDownLeft, BookOpen, FileText, Save, Trash2, Search, Bookmark,
} from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';
import { usePasteStore, type PasteEntry } from '../store/pasteStore';
import { captureClaudeInput, looksLikePastePlaceholder } from '../lib/terminalInput';
import { detectKindClient, kindToExt } from '../lib/pasteKind';
import { toast } from '../store/toastStore';

// Mirrors the backend Snippet shape (see SnippetsModal.tsx / commands.rs).
interface Snippet {
  id: string;
  title: string;
  content: string;
  category: string;
  created_at: string;
}

// Mirrors the backend hint shape (see HintsPanel.tsx / config.rs).
interface Hint {
  title: string;
  command: string;
  description: string;
}
interface HintCategory {
  name: string;
  icon: string;
  hints: Hint[];
}

const SNIPPET_CATEGORY = 'Prompts';

// Normalize line endings to LF and wrap in bracketed-paste markers. This is the
// crux of the feature: writing a raw multi-line string to the PTY would let an
// embedded newline submit the prompt early and split it across sends. Bracketed
// paste (ESC[200~ ... ESC[201~) tells Claude Code "this is a paste" so newlines
// stay literal in the input line - exactly how xterm forwards a clipboard paste.
function toBracketedPaste(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n');
  return `\x1b[200~${normalized}\x1b[201~`;
}

type SidePanel = 'none' | 'guide' | 'snippets';

export function PromptEditorDrawer() {
  const open = useAppStore((s) => s.promptEditorOpen);
  const seedTargetId = useAppStore((s) => s.promptEditorTargetId);
  const closeEditor = useAppStore((s) => s.closePromptEditor);

  const terminals = useTerminalStore((s) => s.terminals);
  const activeId = useTerminalStore((s) => s.activeTerminalId);
  const writeToTerminal = useTerminalStore((s) => s.writeToTerminal);

  const [content, setContent] = useState('');
  const [targetId, setTargetId] = useState<string | null>(null);
  const [side, setSide] = useState<SidePanel>('none');
  const [busy, setBusy] = useState(false);

  const [hints, setHints] = useState<HintCategory[]>([]);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [guideSearch, setGuideSearch] = useState('');

  // Inline "save current as snippet" flow.
  const [savingSnippet, setSavingSnippet] = useState(false);
  const [snippetTitle, setSnippetTitle] = useState('');

  // Keep the Monaco instance so snippet/guide clicks can insert at the cursor.
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  // Track which terminal the current `content` belongs to, so switching the
  // target dropdown flushes the old draft before loading the new one.
  const draftOwnerRef = useRef<string | null>(null);
  // Mirror of `targetId` for the paste listener, which is attached once on mount
  // and would otherwise close over a stale target.
  const targetIdRef = useRef<string | null>(null);

  const visibleTerminals = useMemo(
    () => Array.from(terminals.values()).filter(
      (t) => !t.scriptParentId && !t.isShellTerminal,
    ),
    [terminals],
  );

  // Seed editor state when the drawer opens. Text captured from the terminal's
  // current input line wins over a stored draft so the user continues exactly
  // where they left off - but only when it's plainly readable. Claude collapses
  // pasted/multi-line input into a "[Pasted text #1 +4 lines]" placeholder; that
  // token is not the real prompt, so we ignore it and fall back to the editor's
  // own draft (the source of truth), which always holds the real text.
  useEffect(() => {
    if (!open) return;
    const id = seedTargetId ?? activeId ?? null;
    const seed = (useAppStore.getState().promptEditorSeed ?? '').trim();
    const cleanSeed = seed && !looksLikePastePlaceholder(seed) ? seed : '';
    const draft = id ? useAppStore.getState().promptDrafts[id] ?? '' : '';
    const initial = cleanSeed || draft;
    setTargetId(id);
    setContent(initial);
    draftOwnerRef.current = id;
    setSavingSnippet(false);
    setSnippetTitle('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Lazy-load guide + snippets the first time the side panel is shown.
  useEffect(() => {
    if (side === 'guide' && hints.length === 0) {
      invoke<HintCategory[]>('get_hints').then(setHints).catch(() => { /* ignore */ });
    }
    if (side === 'snippets') {
      invoke<Snippet[]>('get_snippets').then(setSnippets).catch(() => { /* ignore */ });
    }
  }, [side, hints.length]);

  const stats = useMemo(() => {
    const trimmed = content.trim();
    const lines = content === '' ? 0 : content.split('\n').length;
    const words = trimmed === '' ? 0 : trimmed.split(/\s+/).length;
    return { lines, words, chars: content.length };
  }, [content]);

  // Persist every edit into the (ephemeral) per-terminal draft store without
  // subscribing to it here - avoids a write→render→write feedback loop.
  const handleContentChange = (value: string | undefined) => {
    const next = value ?? '';
    setContent(next);
    if (targetId) useAppStore.getState().setPromptDraft(targetId, next);
  };

  const handleChangeTarget = (nextId: string | null) => {
    // Flush the current draft to its owner, then load the new target's draft.
    if (draftOwnerRef.current) {
      useAppStore.getState().setPromptDraft(draftOwnerRef.current, content);
    }
    const draft = nextId ? useAppStore.getState().promptDrafts[nextId] ?? '' : '';
    setTargetId(nextId);
    setContent(draft);
    draftOwnerRef.current = nextId;
  };

  const insertAtCursor = (text: string) => {
    const editor = editorRef.current;
    if (!editor) {
      handleContentChange(content + text);
      return;
    }
    const selection = editor.getSelection();
    if (selection) {
      editor.executeEdits('prompt-insert', [
        { range: selection, text, forceMoveMarkers: true },
      ]);
    }
    editor.focus();
  };

  // Keep the paste handler's view of the target current without re-registering.
  useEffect(() => { targetIdRef.current = targetId; }, [targetId]);

  // Mirror the terminal's large-paste guard (TerminalView). A native DOM `paste`
  // listener never sees Monaco's internal textarea paste path (so Ctrl+V slips
  // through), so we hook Monaco's own onDidPaste instead: it fires for every
  // paste with the inserted range. When the blob is large we offer (but never
  // force) to save it as a file and reference it instead - the pasted text stays
  // in the editor either way.
  const offerLargePaste = useCallback(
    (editor: Parameters<OnMount>[0], pasted: string, range: IRange) => {
      // Saving as a file needs a target terminal to resolve a cwd. Without one we
      // can't produce a referenceable path, so leave the paste inline.
      const target = targetIdRef.current;
      if (!target) return;

      const bytes = new TextEncoder().encode(pasted).length;
      const lines = pasted.split('\n').length;

      // The pasted text stays in the editor (Monaco handles large text fine).
      // We only OFFER to swap it for a file reference - if the toast is ignored
      // the content is kept, never lost. Replace the pasted range in place.
      const replacePasted = (value: string) => {
        editor.executeEdits('prompt-paste', [
          { range, text: value, forceMoveMarkers: true },
        ]);
        editor.focus();
      };

      toast.warning(
        'Large paste detected',
        `${(bytes / 1024).toFixed(1)} KB · ${lines} lines - sending this inline can bog down Claude Code. Save it as a file and reference it instead?`,
        {
          duration: 15000,
          actions: [
            {
              label: 'Save & Reference',
              variant: 'primary',
              onClick: async () => {
                try {
                  const entry = await invoke<PasteEntry>('write_paste', {
                    terminalId: target,
                    content: pasted,
                    extension: kindToExt(detectKindClient(pasted)),
                  });
                  usePasteStore.getState().add(target, entry, pasted);
                  replacePasted(`@${entry.relative_path}`);
                } catch (err) {
                  toast.error('Failed to save paste', String(err));
                }
              },
            },
            {
              label: 'Keep inline',
              variant: 'neutral',
              onClick: () => editor.focus(),
            },
            {
              label: "Don't ask again",
              variant: 'danger',
              onClick: () => useAppStore.getState().setPasteAutoDetectEnabled(false),
            },
          ],
        },
      );
    },
    [],
  );

  const inject = async (withEnter: boolean) => {
    if (!targetId) {
      toast.error('No target terminal', 'Pick a terminal to send the prompt to.');
      return;
    }
    if (!content.trim()) return;
    setBusy(true);
    try {
      // Injecting must make the terminal hold *exactly* the editor content - a
      // full replace, not an append. Re-capture the live input and clear it with
      // Ctrl+U before writing. Ctrl+U on an empty line no-ops, so we send a few
      // extra past the captured line count: this guards against under-counting
      // (a line we failed to scrape) which would otherwise leave a remnant and
      // turn the write into an append. Overcounting is always harmless.
      const xterm = useTerminalStore.getState().terminals.get(targetId)?.xterm;
      const current = xterm ? captureClaudeInput(xterm) : '';
      const clearCount = Math.max(1, current.split('\n').length) + 3;
      await writeToTerminal(targetId, '\x15'.repeat(clearCount));
      await writeToTerminal(targetId, toBracketedPaste(content));
      if (withEnter) {
        // Send: the prompt is submitted and consumed, so drop the draft - the
        // next open starts fresh.
        await writeToTerminal(targetId, '\r');
        useAppStore.getState().clearPromptDraft(targetId);
      }
      // Insert (no Enter): keep the draft so reopening shows the real prompt
      // even though Claude now displays it as a "[Pasted text ...]" placeholder.
      closeEditor();
    } catch (err) {
      toast.error('Failed to write to terminal', String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSaveSnippet = async () => {
    const title = snippetTitle.trim();
    if (!title || !content.trim()) return;
    try {
      const snippet: Snippet = {
        id: crypto.randomUUID(),
        title,
        content,
        category: SNIPPET_CATEGORY,
        created_at: new Date().toISOString(),
      };
      await invoke('save_snippet', { snippet });
      setSnippets((prev) => [snippet, ...prev.filter((s) => s.id !== snippet.id)]);
      setSavingSnippet(false);
      setSnippetTitle('');
      toast.success('Snippet saved', `"${title}" added to Prompts.`);
    } catch (err) {
      toast.error('Failed to save snippet', String(err));
    }
  };

  const handleDeleteSnippet = async (snippet: Snippet) => {
    try {
      await invoke('delete_snippet', { id: snippet.id });
      setSnippets((prev) => prev.filter((s) => s.id !== snippet.id));
    } catch (err) {
      toast.error('Failed to delete snippet', String(err));
    }
  };

  const filteredHints = useMemo(() => {
    const q = guideSearch.toLowerCase();
    return hints
      .map((cat) => ({
        ...cat,
        hints: cat.hints.filter(
          (h) => !q || h.title.toLowerCase().includes(q) || h.command.toLowerCase().includes(q),
        ),
      }))
      .filter((cat) => cat.hints.length > 0);
  }, [hints, guideSearch]);

  const toggleSide = (panel: SidePanel) =>
    setSide((prev) => (prev === panel ? 'none' : panel));

  const canSubmit = !busy && !!content.trim() && !!targetId;

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 bg-black/40 z-[200]"
            onClick={closeEditor}
          />
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'tween', duration: 0.2, ease: 'easeOut' }}
            className="fixed top-0 right-0 bottom-0 w-[680px] max-w-[95vw] bg-elevation-2 ring-1 ring-white/5 z-[201] flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
              <h2 className="text-text-primary text-sm font-medium">Prompt Editor</h2>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => toggleSide('guide')}
                  className={`p-1.5 rounded transition-colors ${
                    side === 'guide'
                      ? 'bg-accent-primary/20 text-accent-primary'
                      : 'text-text-tertiary hover:text-text-primary hover:bg-white/5'
                  }`}
                  title="Prompt guide / commands"
                  aria-label="Toggle guide"
                >
                  <BookOpen size={15} />
                </button>
                <button
                  onClick={() => toggleSide('snippets')}
                  className={`p-1.5 rounded transition-colors ${
                    side === 'snippets'
                      ? 'bg-accent-primary/20 text-accent-primary'
                      : 'text-text-tertiary hover:text-text-primary hover:bg-white/5'
                  }`}
                  title="Saved snippets"
                  aria-label="Toggle snippets"
                >
                  <Bookmark size={15} />
                </button>
                <button
                  onClick={closeEditor}
                  className="p-1.5 rounded text-text-tertiary hover:text-text-primary hover:bg-white/5"
                  aria-label="Close"
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            {/* Body: editor column + optional side panel */}
            <div className="flex-1 min-h-0 flex">
              {/* Editor column */}
              <div className="flex-1 min-w-0 flex flex-col px-4 py-3 gap-3">
                <div>
                  <label className="text-text-tertiary text-[11px] uppercase tracking-wide">
                    Target terminal
                  </label>
                  <select
                    value={targetId ?? ''}
                    onChange={(e) => handleChangeTarget(e.target.value || null)}
                    className="mt-1 w-full bg-bg-primary text-text-primary text-[13px] px-2 py-1.5 rounded ring-1 ring-white/10"
                  >
                    {visibleTerminals.length === 0 && <option value="">No terminals open</option>}
                    {visibleTerminals.map((t) => (
                      <option key={t.config.id} value={t.config.id}>
                        {t.config.nickname || t.config.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex-1 min-h-0 flex flex-col gap-1">
                  <label className="text-text-tertiary text-[11px] uppercase tracking-wide">
                    Prompt
                  </label>
                  <div className="flex-1 min-h-0 rounded ring-1 ring-white/10 overflow-hidden">
                    <Editor
                      height="100%"
                      language="markdown"
                      value={content}
                      onChange={handleContentChange}
                      onMount={(editor) => {
                        editorRef.current = editor;
                        editor.focus();
                        // onDidPaste fires for every paste (incl. Ctrl+V). Measure
                        // the inserted text and, when it's large, hand off to the
                        // save-as-file flow.
                        editor.onDidPaste((e) => {
                          const app = useAppStore.getState();
                          if (!app.pasteAutoDetectEnabled) return;
                          const model = editor.getModel();
                          if (!model) return;
                          const pasted = model.getValueInRange(e.range);
                          if (!pasted) return;
                          const bytes = new TextEncoder().encode(pasted).length;
                          const lines = pasted.split('\n').length;
                          if (
                            bytes < app.pasteAutoDetectThresholdBytes &&
                            lines < app.pasteAutoDetectThresholdLines
                          ) {
                            return; // small enough - leave it inline
                          }
                          offerLargePaste(editor, pasted, e.range);
                        });
                      }}
                      theme="vs-dark"
                      options={{
                        minimap: { enabled: false },
                        scrollBeyondLastLine: false,
                        lineNumbers: 'off',
                        fontSize: 13,
                        fontFamily: '"JetBrains Mono", "Fira Code", monospace',
                        wordWrap: 'on',
                        quickSuggestions: false,
                        renderLineHighlight: 'none',
                      }}
                    />
                  </div>
                  <div className="text-text-tertiary text-[11px] flex gap-3">
                    <span>Lines: {stats.lines.toLocaleString()}</span>
                    <span>Words: {stats.words.toLocaleString()}</span>
                    <span>Chars: {stats.chars.toLocaleString()}</span>
                  </div>
                </div>
              </div>

              {/* Side panel */}
              {side !== 'none' && (
                <div className="w-[260px] flex-shrink-0 border-l border-white/5 flex flex-col">
                  {side === 'guide' ? (
                    <>
                      <div className="p-2 border-b border-white/5">
                        <div className="relative">
                          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary" />
                          <input
                            type="text"
                            placeholder="Search commands..."
                            value={guideSearch}
                            onChange={(e) => setGuideSearch(e.target.value)}
                            className="w-full bg-bg-primary ring-1 ring-white/10 rounded py-1.5 pl-7 pr-2 text-[12px] text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-accent-primary"
                          />
                        </div>
                      </div>
                      <div className="flex-1 overflow-y-auto p-2">
                        {filteredHints.map((cat) => (
                          <div key={cat.name} className="mb-2">
                            <p className="text-text-tertiary text-[10px] uppercase tracking-wide px-1 mb-1">
                              {cat.name}
                            </p>
                            {cat.hints.map((h) => (
                              <button
                                key={h.title}
                                onClick={() => insertAtCursor(h.command)}
                                className="w-full text-left px-2 py-1.5 rounded hover:bg-white/[0.05] group"
                                title={h.description}
                              >
                                <span className="block text-text-primary text-[12px] truncate">{h.title}</span>
                                <code className="text-accent-primary text-[11px]">{h.command}</code>
                              </button>
                            ))}
                          </div>
                        ))}
                        {filteredHints.length === 0 && (
                          <p className="text-text-tertiary text-[12px] text-center py-4">No matches</p>
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="px-3 py-2 border-b border-white/5 flex items-center gap-1.5">
                        <FileText size={13} className="text-text-tertiary" />
                        <span className="text-text-secondary text-[12px] font-medium">Saved prompts</span>
                      </div>
                      <div className="flex-1 overflow-y-auto p-2">
                        {snippets.map((s) => (
                          <div
                            key={s.id}
                            className="group flex items-start justify-between gap-1 px-2 py-1.5 rounded hover:bg-white/[0.05]"
                          >
                            <button
                              onClick={() => insertAtCursor(s.content)}
                              className="flex-1 min-w-0 text-left"
                              title="Insert at cursor"
                            >
                              <span className="block text-text-primary text-[12px] truncate">{s.title}</span>
                              <span className="block text-text-tertiary text-[10px] truncate">
                                {s.content.replace(/\s+/g, ' ').slice(0, 48)}
                              </span>
                            </button>
                            <button
                              onClick={() => handleDeleteSnippet(s)}
                              className="opacity-0 group-hover:opacity-100 p-0.5 text-text-tertiary hover:text-error"
                              title="Delete"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        ))}
                        {snippets.length === 0 && (
                          <p className="text-text-tertiary text-[12px] text-center py-4">
                            No saved prompts yet
                          </p>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Inline "save as snippet" row */}
            {savingSnippet && (
              <div className="px-4 py-2 border-t border-white/5 flex items-center gap-2">
                <input
                  autoFocus
                  type="text"
                  placeholder="Snippet title..."
                  value={snippetTitle}
                  onChange={(e) => setSnippetTitle(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSaveSnippet(); }}
                  className="flex-1 bg-bg-primary text-text-primary text-[13px] px-2 py-1.5 rounded ring-1 ring-white/10 focus:outline-none focus:ring-accent-primary"
                />
                <button
                  onClick={handleSaveSnippet}
                  disabled={!snippetTitle.trim() || !content.trim()}
                  className="text-[12px] px-3 py-1.5 rounded bg-accent-primary/20 text-accent-primary hover:bg-accent-primary/30 disabled:opacity-40"
                >
                  Save
                </button>
                <button
                  onClick={() => { setSavingSnippet(false); setSnippetTitle(''); }}
                  className="text-[12px] px-2 py-1.5 rounded text-text-secondary hover:bg-white/5"
                >
                  Cancel
                </button>
              </div>
            )}

            {/* Footer */}
            <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-white/5">
              <button
                onClick={() => setSavingSnippet((v) => !v)}
                disabled={!content.trim()}
                className="text-[12px] px-3 py-1.5 rounded text-text-secondary hover:bg-white/5 disabled:opacity-40 flex items-center gap-1.5"
                title="Save the current prompt as a reusable snippet"
              >
                <Save size={13} /> Save as snippet
              </button>
              <div className="flex gap-2">
                <button
                  onClick={() => inject(false)}
                  disabled={!canSubmit}
                  className="text-[12px] px-3 py-1.5 rounded bg-white/5 text-text-secondary hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                  title="Put the prompt in the terminal input (you press Enter)"
                >
                  <CornerDownLeft size={13} /> Insert
                </button>
                <button
                  onClick={() => inject(true)}
                  disabled={!canSubmit}
                  className="text-[12px] px-3 py-1.5 rounded bg-accent-primary text-white hover:bg-accent-primary/90 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                  title="Insert and submit to Claude now"
                >
                  <Send size={13} /> Send
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
