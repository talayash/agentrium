// Markdown helpers for text we stage for an agent. The input may be page- or
// diff-controlled, so backtick runs inside it must never close our spans.

function longestRun(s: string, ch: string): number {
  let best = 0;
  let run = 0;
  for (const c of s) {
    run = c === ch ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

/** Inline code that the text inside can't break out of. */
export function inlineCode(s: string): string {
  const ticks = '`'.repeat(longestRun(s, '`') + 1);
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${s}${pad}${ticks}`;
}

/** Fenced block whose fence is longer than any backtick run in the body. */
export function fenced(lang: string, body: string): string {
  const fence = '`'.repeat(Math.max(3, longestRun(body, '`') + 1));
  return `${fence}${lang}\n${body}\n${fence}`;
}
