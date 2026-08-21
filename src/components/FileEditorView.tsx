import { useEffect, useMemo, useRef } from 'react';
import { Loader2, AlertCircle, Save, RefreshCw, FileCode2, GitCompareArrows } from 'lucide-react';
import Editor, { DiffEditor, type OnMount, type DiffOnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { useAppStore } from '../store/appStore';
import { toast } from '../store/toastStore';
import { languageFromPath } from './monacoSetup';
import { pathToFileUri } from '../lib/lsp/paths';

interface FileEditorViewProps {
  path: string;
}

/**
 * Inline Monaco editor for a single open file tab. Uses `path` as Monaco's
 * model key so switching between file tabs preserves per-file cursor position,
 * selection, and undo history - same behavior as VS Code.
 */
export function FileEditorView({ path }: FileEditorViewProps) {
  const tab = useAppStore((s) => s.openFiles.find((t) => t.path === path));
  const setFileTabContent = useAppStore((s) => s.setFileTabContent);
  const setFileTabMode = useAppStore((s) => s.setFileTabMode);
  const saveFileTab = useAppStore((s) => s.saveFileTab);
  const reloadFileTab = useAppStore((s) => s.reloadFileTab);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const diffEditorRef = useRef<editor.IStandaloneDiffEditor | null>(null);

  const dirty = tab ? tab.content !== tab.original : false;
  const language = useMemo(() => languageFromPath(path), [path]);
  // Model key as a proper file:// URI. Passing the raw Windows path would make
  // monaco.Uri.parse() treat 'C:' as a scheme and percent-encode the
  // backslashes, so LSP diagnostics (matched via pathKey) would never attach.
  const modelUri = useMemo(() => pathToFileUri(path), [path]);

  // Ctrl/Cmd+S saves the active file. Only active when this path is the
  // currently-focused file tab (the parent only mounts us for the active tab).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!dirty) return;
        saveFileTab(path).catch((err) => {
          toast.error('Save failed', typeof err === 'string' ? err : 'Unknown error');
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [path, dirty, saveFileTab]);

  const onMount: OnMount = (ed) => {
    editorRef.current = ed;
    ed.focus();
  };

  const onDiffMount: DiffOnMount = (ed) => {
    diffEditorRef.current = ed;
    const modified = ed.getModifiedEditor();
    // Treat the modified (right) side as editable and pipe its changes into
    // the store so dirty tracking and Save continue to work in diff mode.
    modified.onDidChangeModelContent(() => {
      setFileTabContent(path, modified.getValue());
    });
    modified.focus();
  };

  if (!tab) return null;

  return (
    <div className="h-full flex flex-col bg-bg-primary">
      {/* Breadcrumb / status bar for the file */}
      <div className="flex items-center justify-between px-3 h-7 bg-elevation-0 border-b border-[var(--ij-divider-soft)] flex-shrink-0">
        <p className="text-text-tertiary text-[11px] font-mono truncate" title={path}>
          {path}
        </p>
        <div className="flex items-center gap-1">
          {tab.repoRoot && (
            <button
              onClick={() => setFileTabMode(path, tab.mode === 'diff' ? 'edit' : 'diff')}
              className={`flex items-center gap-1 h-5 px-1.5 rounded-[4px] text-[10.5px] transition-colors ${
                tab.mode === 'diff'
                  ? 'bg-accent-primary/20 text-accent-primary'
                  : 'text-text-tertiary hover:text-text-primary hover:bg-white/[0.06]'
              }`}
              title={tab.mode === 'diff' ? 'Switch to plain editor' : 'Show diff against HEAD'}
            >
              {tab.mode === 'diff' ? <FileCode2 size={10} strokeWidth={1.75} /> : <GitCompareArrows size={10} strokeWidth={1.75} />}
              {tab.mode === 'diff' ? 'Edit' : 'Diff'}
            </button>
          )}
          <button
            onClick={() => reloadFileTab(path)}
            disabled={tab.loading}
            className="flex items-center gap-1 h-5 px-1.5 rounded-[4px] text-[10.5px] text-text-tertiary hover:text-text-primary hover:bg-white/[0.06] transition-colors disabled:opacity-40"
            title="Reload from disk"
          >
            <RefreshCw size={10} className={tab.loading ? 'animate-spin' : ''} strokeWidth={1.75} />
            Reload
          </button>
          <button
            onClick={() => {
              if (!dirty) return;
              saveFileTab(path).catch((err) => {
                toast.error('Save failed', typeof err === 'string' ? err : 'Unknown error');
              });
            }}
            disabled={!dirty || tab.saving || tab.loading}
            className="flex items-center gap-1 h-5 px-1.5 rounded-[4px] text-[10.5px] font-medium bg-accent-primary hover:bg-accent-secondary text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title="Save (Ctrl+S)"
          >
            {tab.saving ? <Loader2 size={10} className="animate-spin" /> : <Save size={10} />}
            Save
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 relative">
        {tab.loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-bg-primary/80 z-10">
            <div className="flex items-center gap-2 text-text-secondary text-[12px]">
              <Loader2 size={14} className="animate-spin" />
              Loading…
            </div>
          </div>
        )}
        {tab.error ? (
          <div className="flex items-start justify-center h-full p-6">
            <div className="flex items-start gap-2 max-w-md text-red-400 text-[12.5px]">
              <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
              <p>{tab.error}</p>
            </div>
          </div>
        ) : tab.mode === 'diff' ? (
          <DiffEditor
            // Remount on file switch: DiffEditorWidget swaps its modified
            // TextModel when modifiedModelPath changes, and if disposal races
            // that async swap, Monaco throws "TextModel got disposed before
            // DiffEditorWidget model got reset". A hard remount side-steps it.
            key={path}
            height="100%"
            language={language}
            original={tab.headContent}
            modified={tab.content}
            // Key the editable (right) side by the real file URI so LSP
            // markers attach in diff mode too. The original (HEAD) side keeps
            // its auto-generated in-memory model - it gets no markers.
            modifiedModelPath={modelUri}
            onMount={onDiffMount}
            theme="vs-dark"
            options={{
              fontSize: 13,
              renderSideBySide: true,
              automaticLayout: true,
              readOnly: false,
              originalEditable: false,
              wordWrap: 'off',
              scrollBeyondLastLine: false,
              smoothScrolling: true,
              padding: { top: 8, bottom: 8 },
            }}
          />
        ) : (
          <Editor
            height="100%"
            language={language}
            path={modelUri}
            value={tab.content}
            onChange={(v) => setFileTabContent(path, v ?? '')}
            onMount={onMount}
            theme="vs-dark"
            options={{
              fontSize: 13,
              minimap: { enabled: true },
              automaticLayout: true,
              wordWrap: 'off',
              tabSize: 2,
              scrollBeyondLastLine: false,
              renderWhitespace: 'selection',
              smoothScrolling: true,
              cursorBlinking: 'smooth',
              padding: { top: 8, bottom: 8 },
            }}
          />
        )}
      </div>
    </div>
  );
}
