// Maps file paths to (backend server key, LSP languageId). The server key
// matches src-tauri/src/lsp/acquire.rs::server_spec. languageId follows the
// LSP spec ('typescriptreact' for .tsx - tsserver cares about the react
// variants for JSX diagnostics).

export type LspServer = 'typescript' | 'python' | 'rust';

export interface LspBinding {
  server: LspServer;
  languageId: string;
}

const BY_EXT: Record<string, LspBinding> = {
  ts: { server: 'typescript', languageId: 'typescript' },
  tsx: { server: 'typescript', languageId: 'typescriptreact' },
  js: { server: 'typescript', languageId: 'javascript' },
  jsx: { server: 'typescript', languageId: 'javascriptreact' },
  mjs: { server: 'typescript', languageId: 'javascript' },
  cjs: { server: 'typescript', languageId: 'javascript' },
  py: { server: 'python', languageId: 'python' },
  pyi: { server: 'python', languageId: 'python' },
  rs: { server: 'rust', languageId: 'rust' },
};

export function lspServerForPath(path: string): LspBinding | null {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  return BY_EXT[ext] ?? null;
}
