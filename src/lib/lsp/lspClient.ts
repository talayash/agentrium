// Singleton bridge between the app and the Rust LSP subsystem.
//
// Doc sync: subscribes to appStore.openFiles and mirrors loaded, LSP-eligible
// tabs to the backend (didOpen / debounced didChange / didClose).
// Diagnostics: listens for `lsp-diagnostics` events, converts to Monaco
// markers, and applies them to the matching model. Diagnostics arriving
// before the model exists (editor not mounted yet) are cached and applied
// in onDidCreateModel.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import * as monaco from 'monaco-editor';
import { useAppStore, type FileTabState } from '../../store/appStore';
import { lspServerForPath, type LspBinding } from './languages';
import { pathKey, pathToFileUri } from './paths';
import { diagnosticsToMarkers, type LspDiagnostic } from './markers';

const CHANGE_DEBOUNCE_MS = 300;
const MARKER_OWNER = 'lsp';

interface SyncedDoc {
  binding: LspBinding;
  root: string;
  version: number;
  lastSent: string;
  debounce: ReturnType<typeof setTimeout> | null;
}

const synced = new Map<string, SyncedDoc>(); // key: tab.path (raw)
const pendingMarkers = new Map<string, monaco.editor.IMarkerData[]>(); // key: pathKey

function dirname(p: string): string {
  const n = p.replace(/\\/g, '/');
  const idx = n.lastIndexOf('/');
  return idx > 0 ? n.slice(0, idx) : n;
}

function rootFor(tab: FileTabState): string {
  return tab.repoRoot ?? dirname(tab.path);
}

function findModel(key: string): monaco.editor.ITextModel | null {
  return monaco.editor.getModels().find((m) => pathKey(m.uri.toString()) === key) ?? null;
}

/** True if `key` (a pathKey) matches a doc currently mirrored to the backend. */
function isSyncedKey(key: string): boolean {
  for (const path of synced.keys()) {
    if (pathKey(pathToFileUri(path)) === key) return true;
  }
  return false;
}

async function open(tab: FileTabState, binding: LspBinding): Promise<void> {
  const doc: SyncedDoc = {
    binding,
    root: rootFor(tab),
    version: 1,
    lastSent: tab.content,
    debounce: null,
  };
  synced.set(tab.path, doc);
  try {
    await invoke('lsp_did_open', {
      root: doc.root,
      language: binding.server,
      path: tab.path,
      languageId: binding.languageId,
      text: tab.content,
      version: 1,
    });
  } catch (err) {
    // Server missing/crashed: status events + settings page own the UX.
    console.warn('[lsp] didOpen failed:', err);
    synced.delete(tab.path);
  }
}

function change(path: string, doc: SyncedDoc, content: string): void {
  if (doc.debounce) clearTimeout(doc.debounce);
  doc.debounce = setTimeout(() => {
    doc.debounce = null;
    if (content === doc.lastSent) return;
    doc.lastSent = content;
    doc.version += 1;
    invoke('lsp_did_change', {
      root: doc.root,
      language: doc.binding.server,
      path,
      text: content,
      version: doc.version,
    }).catch((err) => console.warn('[lsp] didChange failed:', err));
  }, CHANGE_DEBOUNCE_MS);
}

function close(path: string, doc: SyncedDoc): void {
  if (doc.debounce) clearTimeout(doc.debounce);
  synced.delete(path);
  const key = pathKey(pathToFileUri(path));
  pendingMarkers.delete(key);
  const model = findModel(key);
  if (model) monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
  invoke('lsp_did_close', {
    root: doc.root,
    language: doc.binding.server,
    path,
  }).catch((err) => console.warn('[lsp] didClose failed:', err));
}

function syncTabs(openFiles: FileTabState[], lspEnabled: boolean): void {
  if (!lspEnabled) {
    for (const [path, doc] of [...synced]) close(path, doc);
    pendingMarkers.clear();
    return;
  }
  const present = new Set<string>();
  for (const tab of openFiles) {
    if (tab.loading) continue;
    const binding = lspServerForPath(tab.path);
    if (!binding) continue;
    present.add(tab.path);
    const doc = synced.get(tab.path);
    if (!doc) {
      void open(tab, binding);
    } else if (tab.content !== doc.lastSent) {
      change(tab.path, doc, tab.content);
    } else if (doc.debounce) {
      // Undo back to the already-synced text within the debounce window:
      // cancel the pending didChange so its stale captured content doesn't
      // fire and desync the backend from what the editor shows.
      clearTimeout(doc.debounce);
      doc.debounce = null;
    }
  }
  for (const [path, doc] of [...synced]) {
    if (!present.has(path)) close(path, doc);
  }
}

interface DiagnosticsEvent {
  language: string;
  root: string;
  uri: string;
  diagnostics: LspDiagnostic[];
}

let initialized = false;
let tsServerRunning = false;

// Track how many language servers are currently in `starting` state so the
// global status-bar progress stripe only clears when the *last* one is done.
let startingCount = 0;
function bumpStartingCount(delta: number): void {
  startingCount = Math.max(0, startingCount + delta);
  useAppStore.getState().setGlobalBusy(
    startingCount > 0 ? 'Starting language server…' : null,
  );
}

// Monaco's bundled TS worker paints its own 'typescript'-owned markers. Once
// the real tsserver is connected those are redundant duplicates - and worse,
// the worker is tsconfig-blind. Silence it while our LSP covers TS/JS;
// restore it when LSP is off or the server isn't running so users keep the
// pre-LSP single-file squiggles.
function updateBuiltinTsDiagnostics(): void {
  const builtinOn = !(useAppStore.getState().lspEnabled && tsServerRunning);
  const opts = { noSemanticValidation: !builtinOn, noSyntaxValidation: !builtinOn };
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(opts);
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(opts);
}

interface StatusEvent {
  language: string;
  root: string;
  state: string;
  detail: string | null;
}

export function initLsp(): void {
  if (initialized) return;
  initialized = true;

  // Per-server state - so bumpStartingCount can flip only on transitions.
  const starting = new Set<string>();

  listen<StatusEvent>('lsp-status', (event) => {
    const key = `${event.payload.language}:${event.payload.root}`;
    if (event.payload.state === 'starting') {
      if (!starting.has(key)) {
        starting.add(key);
        bumpStartingCount(+1);
      }
    } else if (starting.has(key)) {
      starting.delete(key);
      bumpStartingCount(-1);
    }

    if (event.payload.language !== 'typescript') return;
    if (event.payload.state === 'running') tsServerRunning = true;
    else if (event.payload.state === 'error' || event.payload.state === 'stopped') tsServerRunning = false;
    updateBuiltinTsDiagnostics();
  }).catch((err) => console.warn('[lsp] listen failed:', err));

  // Status events only fire on spawn transitions; a server that outlived a
  // frontend reload would otherwise go unnoticed. Seed from current state.
  invoke<Array<{ language: string; running_roots: string[] }>>('lsp_status')
    .then((statuses) => {
      const ts = statuses.find((st) => st.language === 'typescript');
      if (ts && ts.running_roots.length > 0) {
        tsServerRunning = true;
        updateBuiltinTsDiagnostics();
      }
    })
    .catch(() => {});

  listen<DiagnosticsEvent>('lsp-diagnostics', (event) => {
    // Servers keep publishing project-wide diagnostics after didClose (the
    // file is still part of the tsconfig/cargo project), so a disabled LSP
    // must drop events or toggling off can't keep markers cleared.
    if (!useAppStore.getState().lspEnabled) return;
    const key = pathKey(event.payload.uri);
    const markers = diagnosticsToMarkers(event.payload.diagnostics) as monaco.editor.IMarkerData[];
    const model = findModel(key);
    if (model) {
      monaco.editor.setModelMarkers(model, MARKER_OWNER, markers);
    } else if (isSyncedKey(key)) {
      // Cache only for docs we're actually syncing. rust-analyzer publishes
      // diagnostics for the whole workspace; caching every uri would grow
      // unboundedly.
      pendingMarkers.set(key, markers);
    }
  }).catch((err) => console.warn('[lsp] listen failed:', err));

  // Apply diagnostics that arrived before the editor mounted the model.
  monaco.editor.onDidCreateModel((model) => {
    const key = pathKey(model.uri.toString());
    const cached = pendingMarkers.get(key);
    if (cached) {
      monaco.editor.setModelMarkers(model, MARKER_OWNER, cached);
      pendingMarkers.delete(key);
    }
  });

  // Mirror file tabs → LSP documents.
  useAppStore.subscribe((state, prev) => {
    if (state.openFiles !== prev.openFiles || state.lspEnabled !== prev.lspEnabled) {
      syncTabs(state.openFiles, state.lspEnabled);
    }
    if (state.lspEnabled !== prev.lspEnabled) updateBuiltinTsDiagnostics();
  });
  const s = useAppStore.getState();
  syncTabs(s.openFiles, s.lspEnabled);
}
