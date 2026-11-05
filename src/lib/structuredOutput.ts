export type StructuredBlock =
  | { kind: 'table'; headers: string[]; rows: string[][] }
  | { kind: 'bars'; items: { label: string; value: number }[] }
  | { kind: 'line'; points: number[] }
  | { kind: 'markdown'; text: string };

const MAX_TABLE_ROWS = 200;
const MAX_BARS = 20;
const MAX_JSON_KEYS = 8;

const SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const LABEL_NUMBER_RE = /^\s*[-*]\s+(.+?):\s*(-?\d+(?:\.\d+)?)\s*%?\s*$/;
const JSON_FENCE_OPEN_RE = /^\s*```json\s*$/i;
const FENCE_OPEN_RE = /^\s*```/;
const FENCE_CLOSE_RE = /^\s*```\s*$/;

function pipeCount(line: string): number {
  let n = 0;
  for (let i = 0; i < line.length; i++) if (line[i] === '|') n++;
  return n;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function cell(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

function fromJson(value: unknown): StructuredBlock | null {
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.every(isNum)) {
      const nums = value as number[];
      if (nums.length >= 5) return { kind: 'line', points: nums };
      if (nums.length >= 3) {
        return { kind: 'bars', items: nums.map((v, i) => ({ label: String(i + 1), value: v })) };
      }
      return null;
    }
    const flat = value.every(
      (o) =>
        o !== null &&
        typeof o === 'object' &&
        !Array.isArray(o) &&
        Object.values(o as object).every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v)),
    );
    if (!flat) return null;
    const headers: string[] = [];
    for (const o of value as Record<string, unknown>[]) {
      for (const k of Object.keys(o)) if (!headers.includes(k)) headers.push(k);
    }
    if (headers.length === 0 || headers.length > MAX_JSON_KEYS) return null;
    const rows = (value as Record<string, unknown>[])
      .slice(0, MAX_TABLE_ROWS)
      .map((o) => headers.map((h) => cell(o[h])));
    return { kind: 'table', headers, rows };
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length >= 2 && entries.every(([, v]) => isNum(v))) {
      return {
        kind: 'bars',
        items: entries.slice(0, MAX_BARS).map(([label, v]) => ({ label, value: v as number })),
      };
    }
  }
  return null;
}

/**
 * Conservative detection of structured content. Anything unsure stays
 * markdown. Blocks are returned in document order.
 */
export function detectStructured(text: string): StructuredBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: StructuredBlock[] = [];
  let buf: string[] = [];

  const flush = () => {
    const t = buf.join('\n');
    if (t.trim()) blocks.push({ kind: 'markdown', text: t });
    buf = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced blocks: json may become structured; other fences are opaque.
    if (FENCE_OPEN_RE.test(line)) {
      let end = i + 1;
      while (end < lines.length && !FENCE_CLOSE_RE.test(lines[end])) end++;
      const closed = end < lines.length;
      const stop = closed ? end : lines.length - 1;
      if (closed && JSON_FENCE_OPEN_RE.test(line)) {
        let parsed: StructuredBlock | null = null;
        try {
          parsed = fromJson(JSON.parse(lines.slice(i + 1, end).join('\n')));
        } catch {
          parsed = null;
        }
        if (parsed) {
          flush();
          blocks.push(parsed);
          i = stop + 1;
          continue;
        }
      }
      buf.push(...lines.slice(i, stop + 1));
      i = stop + 1;
      continue;
    }

    // Markdown table.
    if (
      pipeCount(line) >= 2 &&
      i + 1 < lines.length &&
      SEPARATOR_RE.test(lines[i + 1]) &&
      lines[i + 1].includes('|')
    ) {
      const headers = splitRow(line);
      let j = i + 2;
      const rows: string[][] = [];
      while (j < lines.length && lines[j].includes('|') && rows.length < MAX_TABLE_ROWS) {
        rows.push(splitRow(lines[j]));
        j++;
      }
      flush();
      blocks.push({ kind: 'table', headers, rows });
      i = j;
      continue;
    }

    // label: number list.
    if (LABEL_NUMBER_RE.test(line)) {
      let j = i;
      const items: { label: string; value: number }[] = [];
      while (j < lines.length) {
        const m = LABEL_NUMBER_RE.exec(lines[j]);
        if (!m) break;
        items.push({ label: m[1], value: Number(m[2]) });
        j++;
      }
      if (items.length >= 3) {
        flush();
        blocks.push({ kind: 'bars', items: items.slice(0, MAX_BARS) });
        i = j;
        continue;
      }
    }

    buf.push(line);
    i++;
  }
  flush();
  return blocks;
}
