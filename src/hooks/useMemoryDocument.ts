import { useCallback, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from '../store/toastStore';
import { confirmAction } from '../lib/confirmDialog';

const basename = (path: string) => path.split(/[/\\]/).pop() || path;

/**
 * One editable file in the Memory Editor (a CLAUDE.md, memory or rule file).
 *
 * Two invariants keep text from landing in the wrong file:
 * - A read that resolves after the user picked another file is ignored
 *   (request token), so a slow read of A can never fill B's editor.
 * - Save writes to `loadedPath`, the file the text was actually read from,
 *   and is impossible until that read succeeded.
 * Switching away from unsaved edits asks first.
 */
export function useMemoryDocument<T extends { path: string }>(onError: (message: string | null) => void) {
  const [selected, setSelected] = useState<T | null>(null);
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const requestRef = useRef(0);

  /** True when it is fine to drop the current edits (none, or user agreed). */
  const confirmDiscard = useCallback(async () => {
    if (!dirty) return true;
    const name = loadedPath ? basename(loadedPath) : 'this file';
    return confirmAction(`Discard unsaved changes in ${name}?`, { okLabel: 'Discard' });
  }, [dirty, loadedPath]);

  const select = useCallback(async (file: T) => {
    if (!(await confirmDiscard())) return;
    const request = ++requestRef.current;
    setSelected(file);
    setLoadedPath(null);
    setContent('');
    setDirty(false);
    setLoading(true);
    onError(null);
    try {
      const text = await invoke<string>('read_memory_file', { path: file.path });
      if (request !== requestRef.current) return;
      setContent(text);
      setLoadedPath(file.path);
    } catch (err) {
      if (request !== requestRef.current) return;
      onError(String(err));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [confirmDiscard, onError]);

  const edit = useCallback((value: string) => {
    setContent(value);
    setDirty(true);
  }, []);

  const save = useCallback(async () => {
    if (!loadedPath) return;
    const path = loadedPath;
    setSaving(true);
    onError(null);
    try {
      await invoke('write_memory_file', { path, content });
      setDirty(false);
      toast.success('File Saved', basename(path));
    } catch (err) {
      onError(String(err));
      toast.error('Save Failed', String(err));
    } finally {
      setSaving(false);
    }
  }, [content, loadedPath, onError]);

  return {
    selected,
    content,
    dirty,
    loading,
    saving,
    canSave: dirty && !saving && loadedPath !== null,
    select,
    edit,
    save,
    confirmDiscard,
  };
}
