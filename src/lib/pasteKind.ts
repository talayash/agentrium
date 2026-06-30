// Shared content-sniffing for pasted text, used by both the Paste-as-File drawer
// and the Prompt Editor's large-paste interception so they pick the same file
// extension for a given blob.

export type DetectedKind = 'json' | 'log' | 'xml' | 'text';

/** Best-effort guess of a paste's content kind from its text. */
export function detectKindClient(content: string): DetectedKind {
  const t = content.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) {
    try { JSON.parse(content); return 'json'; } catch { /* not json */ }
  }
  if (t.startsWith('<') && t.includes('>')) return 'xml';
  const markers = ['[INFO]', '[ERROR]', '[WARN]', '[DEBUG]', 'ERROR:', 'WARN:'];
  const lines = content.split('\n').slice(0, 50);
  const hits = lines.filter((l) => markers.some((m) => l.includes(m))).length;
  if (lines.length >= 5 && hits * 4 >= lines.length) return 'log';
  return 'text';
}

/** Map a detected kind to the file extension used on disk. */
export function kindToExt(k: DetectedKind): string {
  return k === 'text' ? 'txt' : k;
}
