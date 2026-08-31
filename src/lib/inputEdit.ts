// Pure text-edit math for the app's own context menu on `<input>` /
// `<textarea>` fields.
//
// We suppress WebView2's native context menu everywhere (it carries a "Refresh"
// item that reloads the document and destroys every open terminal - see
// usePreventWebviewReload), so Cut / Paste in a text field has to be applied by
// us. Splitting the offset arithmetic out here keeps the DOM-poking component
// thin and lets the edge cases - reversed selections, null offsets on
// email/number inputs, out-of-range offsets - be tested directly.

export interface EditableSnapshot {
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
}

export interface ReplacementResult {
  value: string;
  /** Where the caret should sit afterwards. */
  caret: number;
}

export interface ReplacementOptions {
  /** `<input>` cannot render line breaks; collapse them to spaces. */
  singleLine?: boolean;
}

export function applyReplacement(
  snapshot: EditableSnapshot,
  replacement: string,
  options: ReplacementOptions = {},
): ReplacementResult {
  const { value } = snapshot;
  // Null offsets (email/number inputs) mean "no selection" - treat as caret at
  // the end. Offsets can also outrun the value, so clamp both.
  const rawStart = snapshot.selectionStart ?? value.length;
  const rawEnd = snapshot.selectionEnd ?? value.length;
  const clamp = (n: number) => Math.max(0, Math.min(n, value.length));
  // A drag from right to left reports start > end.
  const start = clamp(Math.min(rawStart, rawEnd));
  const end = clamp(Math.max(rawStart, rawEnd));

  const text = options.singleLine ? replacement.replace(/\r\n?|\n/g, ' ') : replacement;

  return {
    value: value.slice(0, start) + text + value.slice(end),
    caret: start + text.length,
  };
}

/**
 * Write a new value into a text field so React notices.
 *
 * Assigning `.value` directly bypasses React's synthetic onChange, so a
 * controlled input would snap back to its stale state on the next render.
 * Going through the prototype's value setter and dispatching a bubbling
 * `input` event is the supported way to drive one from outside React.
 */
export function commitEditableValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
  caret: number,
): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.setSelectionRange(caret, caret);
}

/** The currently selected substring, using the same clamping rules. */
export function selectedText(snapshot: EditableSnapshot): string {
  const { value } = snapshot;
  const rawStart = snapshot.selectionStart ?? value.length;
  const rawEnd = snapshot.selectionEnd ?? value.length;
  const clamp = (n: number) => Math.max(0, Math.min(n, value.length));
  return value.slice(clamp(Math.min(rawStart, rawEnd)), clamp(Math.max(rawStart, rawEnd)));
}
