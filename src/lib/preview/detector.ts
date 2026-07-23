const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;
const URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{1,5})/gi;

const stripAnsi = (s: string): string => s.replace(ANSI_PATTERN, '');

function trimTrailing(url: string): string {
  // Drop trailing '/', punctuation, ANSI residue.
  return url.replace(/[\/,;.)\]]+$/, '');
}

export function detectUrl(text: string): string | null {
  if (!text) return null;
  const clean = stripAnsi(text);
  const matches = clean.match(URL_PATTERN);
  if (!matches || matches.length === 0) return null;
  return trimTrailing(matches[matches.length - 1]);
}
