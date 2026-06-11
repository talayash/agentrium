import { describe, it, expect } from 'vitest';
import { lspServerForPath } from './languages';

describe('lspServerForPath', () => {
  it('maps ts/tsx to the typescript server with correct languageIds', () => {
    expect(lspServerForPath('C:\\a\\b.ts')).toEqual({ server: 'typescript', languageId: 'typescript' });
    expect(lspServerForPath('/a/b.tsx')).toEqual({ server: 'typescript', languageId: 'typescriptreact' });
  });
  it('maps js variants to the typescript server', () => {
    expect(lspServerForPath('a.js')).toEqual({ server: 'typescript', languageId: 'javascript' });
    expect(lspServerForPath('a.jsx')).toEqual({ server: 'typescript', languageId: 'javascriptreact' });
    expect(lspServerForPath('a.mjs')).toEqual({ server: 'typescript', languageId: 'javascript' });
  });
  it('maps python and rust', () => {
    expect(lspServerForPath('main.py')).toEqual({ server: 'python', languageId: 'python' });
    expect(lspServerForPath('lib.rs')).toEqual({ server: 'rust', languageId: 'rust' });
  });
  it('returns null for unsupported files', () => {
    expect(lspServerForPath('a.md')).toBeNull();
    expect(lspServerForPath('Dockerfile')).toBeNull();
  });
});
