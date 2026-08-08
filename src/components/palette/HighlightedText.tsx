import { memo } from 'react';

interface HighlightedTextProps {
  text: string;
  positions: number[];
  className?: string;
  matchClassName?: string;
}

/**
 * Render `text` with characters at `positions` wrapped in a highlighted span.
 * Positions must be sorted ascending. Consecutive positions collapse into
 * a single span for cleaner DOM.
 */
export const HighlightedText = memo(function HighlightedText({
  text,
  positions,
  className,
  matchClassName = 'text-accent-primary font-semibold',
}: HighlightedTextProps) {
  if (positions.length === 0) {
    return <span className={className}>{text}</span>;
  }
  const parts: React.ReactNode[] = [];
  const posSet = new Set(positions);
  let i = 0;
  while (i < text.length) {
    if (posSet.has(i)) {
      // Collect consecutive match run
      let j = i;
      while (j < text.length && posSet.has(j)) j++;
      parts.push(
        <span key={`m-${i}`} className={matchClassName}>{text.slice(i, j)}</span>
      );
      i = j;
    } else {
      // Collect run of non-matches
      let j = i;
      while (j < text.length && !posSet.has(j)) j++;
      parts.push(<span key={`t-${i}`}>{text.slice(i, j)}</span>);
      i = j;
    }
  }
  return <span className={className}>{parts}</span>;
});
