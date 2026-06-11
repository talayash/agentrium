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

export function initLsp(): void {
  if (initialized) return;
  initialized = true;

  void listen<DiagnosticsEvent>('lsp-diagnostics', (event) => {
    const key = pathKey(event.payload.uri);
    const markers = diagnosticsToMarkers(event.payload.diagnostics) as monaco.editor.IMarkerData[];
    const model = findModel(key);
    if (model) {
      monaco.editor.setModelMarkers(model, MARKER_OWNER, markers);
    } else {
      pendingMarkers.set(key, markers);
    }
  });

  // Apply diagnostics that arrived before the editor mounted the model.
  monaco.editor.onDidCreateModel((model) => {
    const cached = pendingMarkers.get(pathKey(model.uri.toString()));
    if (cached) monaco.editor.setModelMarkers(model, MARKER_OWNER, cached);
  });

  // Mirror file tabs → LSP documents.
  useAppStore.subscribe((state, prev) => {
    if (state.openFiles !== prev.openFiles || state.lspEnabled !== prev.lspEnabled) {
      syncTabs(state.openFiles, state.lspEnabled);
    }
  });
  const s = useAppStore.getState();
  syncTabs(s.openFiles, s.lspEnabled);
}
