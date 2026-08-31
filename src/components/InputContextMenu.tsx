import { useCallback, useEffect, useState } from 'react';
import { Copy, ClipboardPaste, Scissors, TextSelect } from 'lucide-react';
import { copyText, readClipboardText } from '../lib/clipboard';
import { applyReplacement, commitEditableValue, selectedText, type EditableSnapshot } from '../lib/inputEdit';
import { toast } from '../store/toastStore';

// App-level right-click menu for `<input>` / `<textarea>` fields.
//
// These used to keep WebView2's native menu (usePreventWebviewReload exempted
// them so users kept cut/copy/paste). That menu also carries a "Refresh" item,
// which reloads the document and destroys every open terminal - the exact
// vector that hook exists to close. Now the native menu is suppressed
// everywhere and this supplies the editing commands instead.
//
// Monaco is excluded: it renders its own context menu and manages its own
// clipboard actions.

type Editable = HTMLInputElement | HTMLTextAreaElement;

interface MenuState {
  x: number;
  y: number;
  target: Editable;
  hasSelection: boolean;
  readOnly: boolean;
}

function isEditable(el: EventTarget | null): el is Editable {
  if (!(el instanceof HTMLElement)) return false;
  if (el.closest('.monaco-editor')) return false;
  // xterm's hidden IME textarea belongs to the terminal's own menu.
  if (el.classList.contains('xterm-helper-textarea')) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    // Only fields that hold text; checkboxes/buttons have nothing to edit.
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(el.type);
  }
  return false;
}

function snapshotOf(el: Editable): EditableSnapshot {
  return { value: el.value, selectionStart: el.selectionStart, selectionEnd: el.selectionEnd };
}

export function InputContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);

  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const target = e.target;
      if (!isEditable(target)) return;
      e.preventDefault();
      setMenu({
        x: e.clientX,
        y: e.clientY,
        target,
        hasSelection: selectedText(snapshotOf(target)).length > 0,
        readOnly: target.readOnly || target.disabled,
      });
    };
    window.addEventListener('contextmenu', onContextMenu);
    return () => window.removeEventListener('contextmenu', onContextMenu);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  const handleCopy = useCallback(() => {
    if (!menu) return;
    const text = selectedText(snapshotOf(menu.target));
    setMenu(null);
    if (text) {
      copyText(text).catch(() => {
        toast.error('Copy failed', 'Could not write to the clipboard.');
      });
    }
  }, [menu]);

  const handleCut = useCallback(() => {
    if (!menu) return;
    const el = menu.target;
    const snap = snapshotOf(el);
    const text = selectedText(snap);
    setMenu(null);
    if (!text) return;
    const { value, caret } = applyReplacement(snap, '');
    // Copy first: if the clipboard write fails, the text is still in the field.
    copyText(text)
      .then((ok) => {
        if (!ok) throw new Error('clipboard write failed');
        commitEditableValue(el, value, caret);
        el.focus();
      })
      .catch(() => {
        toast.error('Cut failed', 'Could not write to the clipboard.');
      });
  }, [menu]);

  const handlePaste = useCallback(() => {
    if (!menu) return;
    const el = menu.target;
    const snap = snapshotOf(el);
    setMenu(null);
    readClipboardText()
      .then((text) => {
        if (!text) return;
        const { value, caret } = applyReplacement(snap, text, {
          singleLine: el instanceof HTMLInputElement,
        });
        commitEditableValue(el, value, caret);
        el.focus();
      })
      .catch(() => {
        toast.error('Paste failed', 'Could not read the clipboard.');
      });
  }, [menu]);

  const handleSelectAll = useCallback(() => {
    if (!menu) return;
    const el = menu.target;
    setMenu(null);
    el.focus();
    el.select();
  }, [menu]);

  if (!menu) return null;

  const items = [
    { label: 'Cut', icon: Scissors, onClick: handleCut, enabled: menu.hasSelection && !menu.readOnly },
    { label: 'Copy', icon: Copy, onClick: handleCopy, enabled: menu.hasSelection },
    { label: 'Paste', icon: ClipboardPaste, onClick: handlePaste, enabled: !menu.readOnly },
    { label: 'Select All', icon: TextSelect, onClick: handleSelectAll, enabled: menu.target.value.length > 0 },
  ];

  return (
    <div
      role="menu"
      data-context-menu="input"
      className="fixed z-[80] min-w-[160px] material-popover rounded-md py-1 select-none"
      style={{ left: menu.x, top: menu.y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map(({ label, icon: Icon, onClick, enabled }) => (
        <button
          key={label}
          type="button"
          role="menuitem"
          disabled={!enabled}
          onClick={onClick}
          className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-[12px] transition-colors ${
            enabled ? 'text-text-primary hover:bg-fill-hover' : 'text-text-tertiary/50 cursor-not-allowed'
          }`}
        >
          <span className={enabled ? 'text-text-tertiary' : 'opacity-50'}>
            <Icon size={13} strokeWidth={1.75} />
          </span>
          <span className="flex-1">{label}</span>
        </button>
      ))}
    </div>
  );
}
