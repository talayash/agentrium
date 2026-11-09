import { createContext, useContext, type ReactNode } from 'react';
import { Toggle as UIToggle } from '../ui/Toggle';

interface RowProps {
  label: string;
  description?: string;
  children: ReactNode;
  align?: 'center' | 'start';
}

export function SettingRow({ label, description, children, align = 'center' }: RowProps) {
  return (
    <div className={`flex ${align === 'center' ? 'items-center' : 'items-start'} justify-between gap-6 py-2`}>
      <div className="flex-1 min-w-0">
        <p className="text-text-primary text-[13px]">{label}</p>
        {description && <p className="text-text-tertiary text-[11.5px] mt-0.5">{description}</p>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

interface ToggleProps { value: boolean; onChange: (v: boolean) => void; label?: string }
export function Toggle({ value, onChange, label }: ToggleProps) {
  // Delegates to the shared iOS-style switch so every settings toggle matches.
  return <UIToggle checked={value} onChange={onChange} ariaLabel={label} size="sm" />;
}

interface SegProps<T extends string> {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}
export function Segmented<T extends string>({ value, options, onChange }: SegProps<T>) {
  return (
    <div className="flex gap-1">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`px-3 h-7 text-[12px] font-medium rounded-lg transition-[background-color,color,box-shadow,transform] duration-100 active:scale-[0.97] ${
            value === o.value
              ? 'bg-accent-primary text-white shadow-[0_2px_8px_var(--accent-glow-md)]'
              : 'bg-fill-hover ring-1 ring-seam text-text-secondary hover:text-text-primary hover:bg-fill-active'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

interface SectionProps { title: ReactNode; description?: string; children: ReactNode }

/**
 * How a page's own PageHeader renders inside SettingsWindow:
 * - 'page': standalone (default, e.g. tests rendering a page alone)
 * - 'sub': one of several pages stacked in a sidebar section; a divider label
 * - 'hidden': the only page of its section; the section header already says it
 */
export type PageHeaderMode = 'page' | 'sub' | 'hidden';
export const PageHeaderModeContext = createContext<PageHeaderMode>('page');
export const PageHighlightContext = createContext(false);

// "Terminal - Behavior" reads as "Behavior" once it sits under a Terminal header.
export function subTitle(title: string): string {
  const i = title.lastIndexOf(' - ');
  return i === -1 ? title : title.slice(i + 3);
}

export function PageHeader({ title, description }: { title: string; description?: string }) {
  const mode = useContext(PageHeaderModeContext);
  const highlighted = useContext(PageHighlightContext);
  if (mode === 'hidden') return null;
  if (mode === 'sub') {
    return (
      <header className="mb-3 mt-1 flex items-baseline gap-3">
        <h3 className="text-text-secondary uppercase tracking-[0.06em] text-[10.5px] font-semibold whitespace-nowrap flex items-center gap-1.5">
          {highlighted && <span aria-label="Matches search" className="w-1.5 h-1.5 rounded-full bg-yellow-400" />}
          {subTitle(title)}
        </h3>
        <div className="flex-1 h-px bg-[var(--seam)]" />
      </header>
    );
  }
  return (
    <header className="mb-4">
      <h2 className="text-text-primary text-[length:var(--text-h2)] font-semibold">{title}</h2>
      {description && <p className="text-text-tertiary text-[12px] mt-1">{description}</p>}
    </header>
  );
}

export function PageSection({ title, description, children }: SectionProps) {
  return (
    <section className="mb-6">
      <h3 className="text-text-primary text-[13px] font-semibold mb-1">{title}</h3>
      {description && <p className="text-text-tertiary text-[11.5px] mb-2">{description}</p>}
      <div className="bg-elevation-2 rounded-xl ring-1 ring-seam px-3.5 py-1 divide-y divide-[var(--seam)]">
        {children}
      </div>
    </section>
  );
}
