import type { ReactNode } from 'react';

/** Inline keyboard-shortcut chip, e.g. <Kbd>Ctrl+B</Kbd>. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex items-center h-[18px] px-1.5 rounded bg-elevation-2 ring-1 ring-border-light text-text-tertiary text-[10.5px] font-sans leading-none">
      {children}
    </kbd>
  );
}
