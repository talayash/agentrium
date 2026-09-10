import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), editor: vi.fn(), diff: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('./monacoSetup', () => ({ languageFromPath: () => 'typescript' }));
vi.mock('@monaco-editor/react', () => ({
  default: (props: unknown) => { mocks.editor(props); return <input aria-label="editor" />; },
  DiffEditor: (props: unknown) => { mocks.diff(props); return <input aria-label="diff" />; },
}));
import { FileEditorView } from './FileEditorView';
import { useAppStore } from '../store/appStore';
import { useToastStore } from '../store/toastStore';

const file = (path: string) => ({ path, content: 'edited', original: 'disk', loading: false, saving: false, error: null, mode: 'edit' as const, headContent: '', repoRoot: null, relativePath: null });
beforeEach(() => {
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  useAppStore.setState({ openFiles: [file('a.ts'), file('b.ts')], activeFilePath: 'a.ts', editorAutoSaveOnBlur: false });
});
afterEach(cleanup);

describe('file editor preferences and saving', () => {
  it('applies live preferences to plain and diff editors', () => {
    useAppStore.setState({ editorFontSize: 24, editorFontFamily: 'test font', editorLineHeight: 1.5, editorWordWrap: true, editorMinimap: false, editorRenderWhitespace: true, editorTabSize: 8 });
    const view = render(<FileEditorView path="a.ts" />);
    expect(mocks.editor.mock.lastCall?.[0].options).toMatchObject({ fontSize: 24, fontFamily: 'test font', lineHeight: 36, wordWrap: 'on', minimap: { enabled: false }, renderWhitespace: 'all', tabSize: 8 });
    useAppStore.getState().setFileTabMode('a.ts', 'diff');
    view.rerender(<FileEditorView path="a.ts" />);
    expect(mocks.diff.mock.lastCall?.[0].options).toMatchObject({ fontSize: 24, wordWrap: 'on' });
  });

  it('saves latest content on tab switch when enabled', async () => {
    useAppStore.setState({ editorAutoSaveOnBlur: true });
    const view = render(<FileEditorView path="a.ts" />);
    useAppStore.getState().setFileTabContent('a.ts', 'latest edit');
    view.rerender(<FileEditorView path="b.ts" />);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('write_text_file', { path: 'a.ts', content: 'latest edit' }));
    expect(useAppStore.getState().openFiles[0].original).toBe('latest edit');
  });

  it('saves on window blur and surfaces write failure without losing content', async () => {
    useAppStore.setState({ editorAutoSaveOnBlur: true });
    mocks.invoke.mockRejectedValue('disk full');
    render(<FileEditorView path="a.ts" />);
    fireEvent.blur(window);
    await waitFor(() => expect(useAppStore.getState().openFiles[0].error).toBe('disk full'));
    expect(useAppStore.getState().openFiles[0].content).toBe('edited');
    expect(useToastStore.getState().toasts.some(t => t.title === 'Auto-save failed')).toBe(true);
  });

  it('saves edits made during an in-flight write when the tab loses focus', async () => {
    useAppStore.setState({ editorAutoSaveOnBlur: true });
    let finish!: () => void;
    mocks.invoke.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const view = render(<FileEditorView path="a.ts" />);
    fireEvent.blur(window);
    useAppStore.getState().setFileTabContent('a.ts', 'newer edit');
    view.rerender(<FileEditorView path="b.ts" />);
    finish();
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('write_text_file', { path: 'a.ts', content: 'newer edit' }));
    expect(useAppStore.getState().openFiles[0].original).toBe('newer edit');
  });

  it('does not save when disabled or when the file was explicitly discarded', () => {
    const view = render(<FileEditorView path="a.ts" />);
    fireEvent.blur(window);
    expect(mocks.invoke).not.toHaveBeenCalled();
    useAppStore.setState({ editorAutoSaveOnBlur: true });
    useAppStore.getState().closeFileTab('a.ts');
    view.unmount();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
