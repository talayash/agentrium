// An element picked in the built-in browser (src-tauri/src/browser.rs
// `PickedElement`). Every field is page-controlled text, capped in Rust; it is
// only staged for the user to read before sending.

export interface PickedElement {
  url: string;
  title: string;
  selector: string;
  tag: string;
  text: string;
  html: string;
}

function longestRun(s: string, ch: string): number {
  let best = 0;
  let run = 0;
  for (const c of s) {
    run = c === ch ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

/** Inline code that page text can't break out of. */
function inlineCode(s: string): string {
  const ticks = '`'.repeat(longestRun(s, '`') + 1);
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${s}${pad}${ticks}`;
}

function fenced(lang: string, body: string): string {
  const fence = '`'.repeat(Math.max(3, longestRun(body, '`') + 1));
  return `${fence}${lang}\n${body}\n${fence}`;
}

export function formatPickedElement(e: PickedElement): string {
  const lines = ['## Page element', '', `URL: ${e.url}`];
  if (e.title) lines.push(`Title: ${e.title}`);
  if (e.selector) lines.push(`Selector: ${inlineCode(e.selector)}`);
  if (e.tag) lines.push(`Element: ${inlineCode(`<${e.tag}>`)}`);
  if (e.text) lines.push('', 'Text:', e.text);
  if (e.html) lines.push('', fenced('html', e.html));
  return lines.join('\n');
}
