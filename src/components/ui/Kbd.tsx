import type { ReactNode } from 'react';

/** Inline keyboard-shortcut chip, e.g. <Kbd>Ctrl+B</Kbd>. Reads as a slightly
 *  raised key: seam ring + a 1px key-shadow under the bottom edge. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex items-center h-[18px] px-1.5 rounded-[5px] bg-elevation-3 ring-1 ring-seam text-text-tertiary text-[10.5px] font-sans leading-none tracking-caption shadow-[0_1px_0_var(--seam)]">
      {children}
    </kbd>
  );
}
