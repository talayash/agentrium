import { GitCompare } from 'lucide-react';
import type { FileTouch } from '../../lib/insightModel';

interface Props {
  files: FileTouch[];
  onOpen: (file: FileTouch) => void;
  /** Omit to hide the diff icon (repo root unknown). */
  onDiff?: (file: FileTouch) => void;
}

export function FilesTouched({ files, onOpen, onDiff }: Props) {
  if (files.length === 0) return null;
  return (
    <ul className="space-y-0.5" data-testid="files-touched">
      {files.map((f) => (
        <li key={f.path} className="flex items-center gap-2 text-[11px]">
          <button
            type="button"
            onClick={() => onOpen(f)}
            title={f.path}
            className="min-w-0 flex-1 truncate text-left text-text-secondary hover:text-text-primary"
          >
            {f.path}
          </button>
          <span className="shrink-0 tabular-nums text-green-400">+{f.added}</span>
          <span className="shrink-0 tabular-nums text-red-400">-{f.removed}</span>
          {onDiff && (
            <button
              type="button"
              onClick={() => onDiff(f)}
              aria-label={`Open diff for ${f.path}`}
              title="Open diff"
              className="shrink-0 text-text-tertiary hover:text-text-primary"
            >
              <GitCompare size={12} strokeWidth={1.75} />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
