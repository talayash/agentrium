import type { ReactNode } from 'react';

/** Inline: **bold**, `code`. Everything else (including links, HTML) is text. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const tok = m[0];
    if (tok.startsWith('**')) {
      out.push(<strong key={`${keyPrefix}-${n++}`}>{tok.slice(2, -2)}</strong>);
    } else {
      out.push(
        <code key={`${keyPrefix}-${n++}`} className="px-1 rounded bg-elevation-2 text-[11px]">
          {tok.slice(1, -1)}
        </code>,
      );
    }
    last = idx + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const UL_RE = /^\s*[-*]\s+/;
const OL_RE = /^\s*\d+\.\s+/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^\s*```/;

export function MiniMarkdown({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);
  const nodes: ReactNode[] = [];
  let i = 0;
  let k = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (FENCE_RE.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++]);
      i++;
      nodes.push(
        <pre key={k++} className="text-[11px] bg-elevation-2 rounded p-2 overflow-x-auto">
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const h = HEADING_RE.exec(line);
    if (h) {
      const key = k++;
      nodes.push(
        <div key={key} className="text-xs font-semibold text-text-primary mt-2" role="heading" aria-level={h[1].length}>
          {renderInline(h[2], `h${key}`)}
        </div>,
      );
      i++;
      continue;
    }

    if (UL_RE.test(line) || OL_RE.test(line)) {
      const ordered = OL_RE.test(line);
      const re = ordered ? OL_RE : UL_RE;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i])) items.push(lines[i++].replace(re, ''));
      const Tag = ordered ? 'ol' : 'ul';
      const key = k++;
      nodes.push(
        <Tag key={key} className={`text-[11px] text-text-secondary pl-4 ${ordered ? 'list-decimal' : 'list-disc'}`}>
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it, `l${key}-${idx}`)}</li>
          ))}
        </Tag>,
      );
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !FENCE_RE.test(lines[i]) &&
      !HEADING_RE.test(lines[i]) &&
      !UL_RE.test(lines[i]) &&
      !OL_RE.test(lines[i])
    ) {
      para.push(lines[i++]);
    }
    const key = k++;
    nodes.push(
      <p key={key} className="text-[11px] text-text-secondary whitespace-pre-wrap">
        {renderInline(para.join('\n'), `p${key}`)}
      </p>,
    );
  }

  return <div className="space-y-1.5">{nodes}</div>;
}
