import { describe, expect, it, vi } from 'vitest';
import { applyReplacement, commitEditableValue, type EditableSnapshot } from './inputEdit';

const snap = (value: string, start: number, end: number): EditableSnapshot => ({
  value,
  selectionStart: start,
  selectionEnd: end,
});

describe('applyReplacement', () => {
  it('replaces the selected range and puts the caret after the insert', () => {
    // "he[llo] world" + "y" -> "hey world", caret after the y
    const r = applyReplacement(snap('hello world', 2, 5), 'y');
    expect(r.value).toBe('hey world');
    expect(r.caret).toBe(3);
  });

  it('inserts at the caret when nothing is selected', () => {
    const r = applyReplacement(snap('ab', 1, 1), 'XY');
    expect(r.value).toBe('aXYb');
    expect(r.caret).toBe(3);
  });

  it('deletes the selection when the replacement is empty (cut)', () => {
    const r = applyReplacement(snap('hello world', 5, 11), '');
    expect(r.value).toBe('hello');
    expect(r.caret).toBe(5);
  });

  it('handles a reversed selection (dragged right to left)', () => {
    // selectionStart > selectionEnd should not produce a scrambled string.
    const r = applyReplacement(snap('hello', 4, 1), 'X');
    expect(r.value).toBe('hXo');
    expect(r.caret).toBe(2);
  });

  it('appends when the caret sits at the end', () => {
    const r = applyReplacement(snap('ab', 2, 2), '!');
    expect(r.value).toBe('ab!');
    expect(r.caret).toBe(3);
  });

  it('replaces everything when the whole field is selected', () => {
    const r = applyReplacement(snap('old', 0, 3), 'new');
    expect(r.value).toBe('new');
    expect(r.caret).toBe(3);
  });

  it('treats null selection offsets as a caret at the end', () => {
    // input types like email/number report null for selectionStart.
    const r = applyReplacement({ value: 'ab', selectionStart: null, selectionEnd: null }, 'c');
    expect(r.value).toBe('abc');
    expect(r.caret).toBe(3);
  });

  it('clamps offsets that run past the end of the value', () => {
    const r = applyReplacement(snap('ab', 5, 9), 'c');
    expect(r.value).toBe('abc');
    expect(r.caret).toBe(3);
  });

  it('strips newlines when the target is a single-line input', () => {
    // Pasting multi-line clipboard text into an <input> must not smuggle in
    // line breaks the field can never render.
    const r = applyReplacement(snap('', 0, 0), 'a\r\nb\nc', { singleLine: true });
    expect(r.value).toBe('a b c');
    expect(r.caret).toBe(5);
  });

  it('keeps newlines for a textarea', () => {
    const r = applyReplacement(snap('', 0, 0), 'a\nb', { singleLine: false });
    expect(r.value).toBe('a\nb');
  });
});

describe('commitEditableValue', () => {
  it('writes the value and fires a bubbling input event React can see', () => {
    const el = document.createElement('input');
    document.body.appendChild(el);
    let bubbled = false;
    document.body.addEventListener('input', () => { bubbled = true; }, { once: true });

    commitEditableValue(el, 'pasted', 6);

    expect(el.value).toBe('pasted');
    expect(bubbled).toBe(true);
    expect(el.selectionStart).toBe(6);
    expect(el.selectionEnd).toBe(6);
    el.remove();
  });

  it('works on a textarea too', () => {
    const el = document.createElement('textarea');
    document.body.appendChild(el);
    commitEditableValue(el, 'a\nb', 3);
    expect(el.value).toBe('a\nb');
    expect(el.selectionStart).toBe(3);
    el.remove();
  });

  it('goes through the prototype setter, not the own property', () => {
    // React tracks the last value it wrote on the node. Setting `.value`
    // directly updates that tracker and React then skips the change, which is
    // exactly the bug this helper exists to avoid - so assert we call the
    // prototype setter.
    const el = document.createElement('input');
    const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    const spy = vi.fn(proto!.set);
    Object.defineProperty(HTMLInputElement.prototype, 'value', { ...proto, set: spy });
    try {
      commitEditableValue(el, 'x', 1);
      expect(spy).toHaveBeenCalledWith('x');
    } finally {
      Object.defineProperty(HTMLInputElement.prototype, 'value', proto!);
    }
  });
});
