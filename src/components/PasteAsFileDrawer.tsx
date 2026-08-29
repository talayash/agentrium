import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import Editor from '@monaco-editor/react';
import { X, Send, Save, Trash2, FileText } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';
import { usePasteStore, type PasteEntry } from '../store/pasteStore';
import { detectKindClient, kindToExt } from '../lib/pasteKind';
import { toast } from '../store/toastStore';
import { copyText } from '../lib/clipboard';
import { drawerMotion } from '../lib/motionTokens';

const EXTENSIONS: { value: string; label: string; lang: string }[] = [
  { value: 'json', label: '.json', lang: 'json' },
  { value: 'log', label: '.log', lang: 'plaintext' },
  { value: 'xml', label: '.xml', lang: 'xml' },
  { value: 'txt', label: '.txt', lang: 'plaintext' },
];

function defaultBaseName(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `paste-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function PasteAsFileDrawer() {
  const open = useAppStore((s) => s.pasteDrawerOpen);
  const seed = useAppStore((s) => s.pasteDrawerSeed);
  const closeDrawer = useAppStore((s) => s.closePasteDrawer);
  const promptTemplate = useAppStore((s) => s.pastePromptTemplate);
  const setPromptTemplate = useAppStore((s) => s.setPastePromptTemplate);

  const terminals = useTerminalStore((s) => s.terminals);
  const activeId = useTerminalStore((s) => s.activeTerminalId);
  const writeToTerminal = useTerminalStore((s) => s.writeToTerminal);

  const [content, setContent] = useState('');
  const [baseName, setBaseName] = useState(defaultBaseName());
  const [extension, setExtension] = useState<string>('txt');
  const [targetId, setTargetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState(false);
  const [tplDraft, setTplDraft] = useState(promptTemplate);

  // Track whether the user manually changed the extension dropdown - if so,
  // we stop auto-flipping it as they type.
  const userTouchedExtRef = useRef(false);

  // Reset editor state when the drawer opens with new seed.
  useEffect(() => {
    if (open) {
      const initial = seed?.content ?? '';
      setContent(initial);
      setBaseName(defaultBaseName());
      const detected = detectKindClient(initial);
      setExtension(kindToExt(detected));
      userTouchedExtRef.current = false;
      setTargetId(seed?.targetTerminalId ?? activeId ?? null);
      setError(null);
      setEditingTemplate(false);
      setTplDraft(promptTemplate);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Re-sniff extension as the editor content changes (until user overrides).
  useEffect(() => {
    if (userTouchedExtRef.current) return;
    const detected = detectKindClient(content);
    setExtension((prev) => {
      const next = kindToExt(detected);
      return prev === next ? prev : next;
    });
  }, [content]);

  const monacoLanguage = useMemo(
    () => EXTENSIONS.find((e) => e.value === extension)?.lang ?? 'plaintext',
    [extension],
  );

  const stats = useMemo(() => {
    const lines = content.split('\n').length;
    const bytes = new TextEncoder().encode(content).length;
    return { lines, bytes };
  }, [content]);

  const recent = usePasteStore((s) => (targetId ? s.list(targetId) : []));

  const visibleTerminals = useMemo(
    () => Array.from(terminals.values()).filter(
      (t) => !t.scriptParentId && !t.isShellTerminal,
    ),
    [terminals],
  );

  const renderPrompt = (relativePath: string): string => {
    return promptTemplate.replace(/\{path\}/g, relativePath);
  };

  const doWrite = async (): Promise<PasteEntry | null> => {
    if (!targetId) {
      setError('Pick a target terminal');
      return null;
    }
    if (!content) {
      setError('Content is empty');
      return null;
    }
    setBusy(true);
    setError(null);
    try {
      const entry = await invoke<PasteEntry>('write_paste', {
        terminalId: targetId,
        content,
        suggestedName: baseName,
        extension,
      });
      usePasteStore.getState().add(targetId, entry, content);
      return entry;
    } catch (err) {
      setError(typeof err === 'string' ? err : 'Failed to write paste');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const handleSend = async () => {
    const entry = await doWrite();
    if (!entry || !targetId) return;
    try {
      await writeToTerminal(targetId, renderPrompt(entry.relative_path));
      toast.success('Sent to terminal', entry.relative_path);
      closeDrawer();
    } catch (err) {
      const msg = typeof err === 'string' ? err : 'Failed to write to terminal';
      setError(msg);
    }
  };

  const handleSaveOnly = async () => {
    const entry = await doWrite();
    if (!entry) return;
    const copied = await copyText(entry.relative_path);
    // Report accurately: don't claim the path was copied if the clipboard write failed.
    if (copied) toast.success('Saved · path copied', entry.relative_path);
    else toast.success('Saved', entry.relative_path);
    closeDrawer();
  };

  const handleResend = async (entry: PasteEntry) => {
    if (!targetId) return;
    try {
      await writeToTerminal(targetId, renderPrompt(entry.relative_path));
      toast.success('Sent to terminal', entry.relative_path);
    } catch (err) {
      toast.error('Failed to send', String(err));
    }
  };

  const handleReopen = async (entry: PasteEntry) => {
    if (!targetId) return;
    try {
      const text = await invoke<string>('read_paste', {
        terminalId: targetId,
        fileName: entry.file_name,
      });
      setContent(text);
      const dot = entry.file_name.lastIndexOf('.');
      if (dot > 0) {
        const ext = entry.file_name.slice(dot + 1);
        if (EXTENSIONS.some((e) => e.value === ext)) {
          setExtension(ext);
          userTouchedExtRef.current = true;
        }
        setBaseName(entry.file_name.slice(0, dot));
      }
    } catch (err) {
      toast.error('Failed to load paste', String(err));
    }
  };

  const handleDeleteRecent = async (entry: PasteEntry) => {
    if (!targetId) return;
    try {
      await invoke('delete_paste', { terminalId: targetId, fileName: entry.file_name });
      usePasteStore.getState().remove(targetId, entry.file_name);
    } catch (err) {
      toast.error('Failed to delete paste', String(err));
    }
  };

  const handleApplyTemplate = () => {
    setPromptTemplate(tplDraft);
    setEditingTemplate(false);
  };

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
            onClick={closeDrawer}
          />
          <motion.div
            {...drawerMotion(540)}
            className="fixed top-0 right-0 bottom-0 w-[520px] material-overlay rounded-l-xl z-[201] flex flex-col"
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-seam">
              <h2 className="text-text-primary text-sm font-medium">Paste as File</h2>
              <button
                onClick={closeDrawer}
                className="text-text-tertiary hover:text-text-primary"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3">
              <div>
                <label className="text-text-tertiary text-[11px] uppercase tracking-wide">
                  Target terminal
                </label>
                <select
                  value={targetId ?? ''}
                  onChange={(e) => setTargetId(e.target.value || null)}
                  className="mt-1 w-full bg-bg-primary text-text-primary text-[13px] px-2 py-1.5 rounded ring-1 ring-seam-strong"
                >
                  {visibleTerminals.length === 0 && <option value="">No terminals open</option>}
                  {visibleTerminals.map((t) => (
                    <option key={t.config.id} value={t.config.id}>
                      {t.config.nickname || t.config.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="text-text-tertiary text-[11px] uppercase tracking-wide">
                    Filename
                  </label>
                  <input
                    type="text"
                    value={baseName}
                    onChange={(e) => setBaseName(e.target.value)}
                    className="mt-1 w-full bg-bg-primary text-text-primary text-[13px] px-2 py-1.5 rounded ring-1 ring-seam-strong font-mono"
                  />
                </div>
                <div className="w-24">
                  <label className="text-text-tertiary text-[11px] uppercase tracking-wide">
                    Type
                  </label>
                  <select
                    value={extension}
                    onChange={(e) => {
                      setExtension(e.target.value);
                      userTouchedExtRef.current = true;
                    }}
                    className="mt-1 w-full bg-bg-primary text-text-primary text-[13px] px-2 py-1.5 rounded ring-1 ring-seam-strong"
                  >
                    {EXTENSIONS.map((e) => (
                      <option key={e.value} value={e.value}>{e.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-text-tertiary text-[11px] uppercase tracking-wide">
                  Content
                </label>
                <div className="h-[280px] rounded ring-1 ring-seam-strong overflow-hidden">
                  <Editor
                    height="100%"
                    language={monacoLanguage}
                    value={content}
                    onChange={(v) => setContent(v ?? '')}
                    theme="vs-dark"
                    options={{
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                      lineNumbers: 'on',
                      fontSize: 12,
                      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
                      wordWrap: 'on',
                    }}
                  />
                </div>
                <div className="text-text-tertiary text-[11px] flex gap-3 flex-wrap">
                  <span>Lines: {stats.lines.toLocaleString()}</span>
                  <span>Size: {formatBytes(stats.bytes)}</span>
                  <span>Detected: {extension}</span>
                  {stats.bytes > 5 * 1024 * 1024 && (
                    <span className="text-warning">Large &mdash; Claude may truncate</span>
                  )}
                </div>
              </div>

              <div>
                <label className="text-text-tertiary text-[11px] uppercase tracking-wide">
                  Prompt template
                </label>
                <div className="mt-1 flex gap-2">
                  <input
                    type="text"
                    value={editingTemplate ? tplDraft : promptTemplate}
                    onChange={(e) => { setEditingTemplate(true); setTplDraft(e.target.value); }}
                    className="flex-1 bg-bg-primary text-text-primary text-[13px] px-2 py-1.5 rounded ring-1 ring-seam-strong font-mono"
                  />
                  {editingTemplate && (
                    <button
                      onClick={handleApplyTemplate}
                      className="text-[12px] px-2 py-1 rounded bg-accent-primary/20 text-accent-primary hover:bg-accent-primary/30"
                    >
                      Save
                    </button>
                  )}
                </div>
                <p className="text-text-tertiary text-[11px] mt-1">
                  Use <code>{'{path}'}</code> for the relative file path.
                </p>
              </div>

              {error && (
                <div className="bg-error/10 ring-1 ring-error/40 text-error text-[12px] px-3 py-2 rounded">
                  {error}
                </div>
              )}

              {recent.length > 0 && (
                <div>
                  <h3 className="text-text-tertiary text-[11px] uppercase tracking-wide flex items-center gap-1">
                    <FileText size={12} /> Recent pastes (this terminal)
                  </h3>
                  <ul className="mt-1 flex flex-col gap-1">
                    {recent.slice(0, 10).map((entry) => (
                      <li
                        key={entry.file_name}
                        className="flex items-center justify-between gap-2 px-2 py-1.5 rounded hover:bg-fill-hover group"
                      >
                        <button
                          onClick={() => handleReopen(entry)}
                          className="flex-1 min-w-0 text-left"
                        >
                          <span className="block text-text-primary text-[12px] truncate font-mono">
                            {entry.file_name}
                          </span>
                          <span className="block text-text-tertiary text-[10px]">
                            {formatBytes(entry.size_bytes)} &middot; {entry.detected_kind}
                          </span>
                        </button>
                        <button
                          onClick={() => handleResend(entry)}
                          className="opacity-0 group-hover:opacity-100 text-[11px] px-1.5 py-0.5 rounded bg-accent-primary/20 text-accent-primary hover:bg-accent-primary/30"
                          title="Resend to terminal"
                        >
                          Send
                        </button>
                        <button
                          onClick={() => handleDeleteRecent(entry)}
                          className="opacity-0 group-hover:opacity-100 text-text-tertiary hover:text-error"
                          title="Delete"
                        >
                          <Trash2 size={13} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-seam">
              <button
                onClick={closeDrawer}
                className="text-[12px] px-3 py-1.5 rounded text-text-secondary hover:bg-fill-hover"
              >
                Discard
              </button>
              <div className="flex gap-2">
                <button
                  onClick={handleSaveOnly}
                  disabled={busy || !content || !targetId}
                  className="text-[12px] px-3 py-1.5 rounded bg-fill-hover text-text-secondary hover:bg-fill-active disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                >
                  <Save size={13} /> Save only
                </button>
                <button
                  onClick={handleSend}
                  disabled={busy || !content || !targetId}
                  className="text-[12px] px-3 py-1.5 rounded bg-accent-primary text-white hover:bg-accent-primary/90 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
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
