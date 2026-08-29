import type { ReactNode } from 'react';
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
export function PageHeader({ title, description }: { title: string; description?: string }) {
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
