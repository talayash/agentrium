// One-time Monaco runtime setup. Imported for side effects by any component
// that renders a Monaco editor. Repeat imports are harmless - the body runs
// once thanks to the module cache.
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { useTerminalStore } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import { toast } from '../store/toastStore';

declare global {
  interface Window { __monacoReady?: boolean }
}

const RUN_SCRIPT_COMMAND = 'claudeTerminal.runPackageScript';

function dirname(p: string): string {
  const normalized = p.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) return normalized;
  // Preserve Windows drive letter + separator (e.g. "C:/")
  if (normalized.length > 3 && /^[A-Za-z]:\/$/.test(normalized.slice(0, 3)) && idx === 2) {
    return normalized.slice(0, 3);
  }
  return normalized.slice(0, idx);
}

function findScriptPositions(text: string): { name: string; line: number }[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return []; }
  if (!parsed || typeof parsed !== 'object') return [];
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== 'object') return [];
  const names = Object.keys(scripts as Record<string, unknown>);

  // Locate the opening brace of the top-level "scripts" block so we only match
  // keys inside it (not a nested key that happens to share a name).
  const scriptsKeyMatch = /"scripts"\s*:\s*\{/.exec(text);
  if (!scriptsKeyMatch) return [];
  const openBraceIdx = text.indexOf('{', scriptsKeyMatch.index);
  if (openBraceIdx === -1) return [];

  let depth = 0;
  let endIdx = -1;
  let inString = false;
  let escape = false;
  for (let i = openBraceIdx; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { endIdx = i; break; } }
  }
  if (endIdx === -1) return [];

  const block = text.slice(openBraceIdx, endIdx + 1);
  const blockStart = openBraceIdx;

  const results: { name: string; line: number }[] = [];
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`"${escaped}"\\s*:`);
    const match = re.exec(block);
    if (!match) continue;
    const absoluteIdx = blockStart + match.index;
    // Line number = count of newlines before this index + 1 (1-based).
    let line = 1;
    for (let i = 0; i < absoluteIdx; i++) if (text[i] === '\n') line++;
    results.push({ name, line });
  }
  return results;
}

function isPackageJson(uri: monaco.Uri): boolean {
  const path = uri.path.replace(/\\/g, '/');
  const last = path.split('/').pop()?.toLowerCase();
  return last === 'package.json';
}

if (typeof window !== 'undefined' && !window.__monacoReady) {
  (self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
    getWorker(_: string, label: string) {
      if (label === 'json') return new jsonWorker();
      if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
      if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
      if (label === 'typescript' || label === 'javascript') return new tsWorker();
      return new editorWorker();
    },
  };
  loader.config({ monaco });

  // Register the "Run Script" command. CodeLens entries reference this via id.
  monaco.editor.registerCommand(
    RUN_SCRIPT_COMMAND,
    (_accessor: unknown, scriptName: string, cwd: string) => {
      const termStore = useTerminalStore.getState();
      const parentId = termStore.activeTerminalId;
      if (!parentId) {
        toast.error('No active terminal', 'Open a Claude terminal first');
        return;
      }
      termStore
        .runScript(parentId, scriptName, cwd)
        .then(() => {
          // Switch focus away from the file editor so the user sees the script
          // output below the parent terminal right away.
          useAppStore.getState().setActiveFilePath(null);
        })
        .catch((err: unknown) => {
          toast.error('Failed to run script', typeof err === 'string' ? err : 'Unknown error');
        });
    }
  );

  // Emit CodeLens above each entry in the `scripts` block of a package.json.
  // The `onDidChange` event fires when model content changes so lenses stay
  // in sync with edits.
  const onDidChange = new monaco.Emitter<void>();
  monaco.editor.onDidCreateModel((model) => {
    if (!isPackageJson(model.uri)) return;
    const sub = model.onDidChangeContent(() => onDidChange.fire());
    model.onWillDispose(() => sub.dispose());
  });

  // Re-fire the lens change event when the user toggles Project Tools so the
  // "▶ Run Script" lenses appear/disappear immediately.
  useAppStore.subscribe((state, prev) => {
    if (state.showFileTree !== prev.showFileTree) onDidChange.fire();
  });

  monaco.languages.registerCodeLensProvider('json', {
    // Monaco's type says this should be IEvent<CodeLensProvider> but at runtime
    // any event that fires triggers a lens refresh - `void` payload is fine.
    onDidChange: onDidChange.event as unknown as monaco.IEvent<monaco.languages.CodeLensProvider>,
    provideCodeLenses(model) {
      // Gate on the Project Tools setting so the lens can be hidden globally.
      if (!useAppStore.getState().showFileTree) {
        return { lenses: [], dispose() {} };
      }
      if (!isPackageJson(model.uri)) {
        return { lenses: [], dispose() {} };
      }
      const scripts = findScriptPositions(model.getValue());
      const fsPath = model.uri.fsPath || model.uri.path.replace(/^\//, '');
      const cwd = dirname(fsPath);
      const lenses: monaco.languages.CodeLens[] = scripts.map((s) => ({
        range: {
          startLineNumber: s.line,
          startColumn: 1,
          endLineNumber: s.line,
          endColumn: 1,
        },
        id: `run-script:${s.name}`,
        command: {
          id: RUN_SCRIPT_COMMAND,
          title: '▶ Run Script',
          arguments: [s.name, cwd],
        },
      }));
      return { lenses, dispose() {} };
    },
    resolveCodeLens(_model, codeLens) { return codeLens; },
  });

  window.__monacoReady = true;
}

export function languageFromPath(path: string): string {
  const lower = path.toLowerCase();
  const ext = lower.split('.').pop() ?? '';
  const byExt: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    json: 'json', jsonc: 'json',
    md: 'markdown', markdown: 'markdown',
    rs: 'rust',
    py: 'python',
    go: 'go',
    java: 'java',
    c: 'c', h: 'c',
    cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
    cs: 'csharp',
    rb: 'ruby',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin', kts: 'kotlin',
    html: 'html', htm: 'html',
    css: 'css',
    scss: 'scss', sass: 'scss',
    less: 'less',
    xml: 'xml',
    yaml: 'yaml', yml: 'yaml',
    toml: 'ini',
    ini: 'ini',
    sh: 'shell', bash: 'shell', zsh: 'shell',
    ps1: 'powershell',
    sql: 'sql',
    dockerfile: 'dockerfile',
    vue: 'html',
    svelte: 'html',
  };
  if (byExt[ext]) return byExt[ext];
  if (lower.endsWith('dockerfile')) return 'dockerfile';
  return 'plaintext';
}
