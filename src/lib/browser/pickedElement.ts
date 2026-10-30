// An element picked in the built-in browser (src-tauri/src/browser.rs
// `PickedElement`). Every field is page-controlled text, capped in Rust; it is
// only staged for the user to read before sending.

import { fenced, inlineCode } from '../markdown';

export interface PickedElement {
  url: string;
  title: string;
  selector: string;
  tag: string;
  text: string;
  html: string;
}

/** Page text on a `Label: value` line must not start a new markdown line. */
const oneLine = (s: string) => s.replace(/\r\n|\r|\n/g, ' ');

export function formatPickedElement(e: PickedElement): string {
  const lines = ['## Page element', '', `URL: ${oneLine(e.url)}`];
  if (e.title) lines.push(`Title: ${oneLine(e.title)}`);
  if (e.selector) lines.push(`Selector: ${inlineCode(e.selector)}`);
  if (e.tag) lines.push(`Element: ${inlineCode(`<${e.tag}>`)}`);
  if (e.text) lines.push('', 'Text:', fenced('', e.text));
  if (e.html) lines.push('', fenced('html', e.html));
  return lines.join('\n');
}
