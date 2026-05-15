import type { ReactNode } from 'react';

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
  return (
    <button
      onClick={() => onChange(!value)}
      aria-label={label}
      className={`relative w-10 h-5 rounded-full transition-colors ${value ? 'bg-accent-primary' : 'bg-border-light'}`}
    >
      <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${value ? 'translate-x-5' : 'translate-x-0'}`} />
    </button>
  );
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
          className={`px-2.5 h-7 text-[12px] rounded-md transition-colors ${
            value === o.value
              ? 'bg-accent-primary text-white'
              : 'bg-bg-elevated ring-1 ring-border-light text-text-secondary hover:bg-white/[0.04]'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

interface SectionProps { title: string; description?: string; children: ReactNode }
export function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <header className="mb-4">
      <h2 className="text-text-primary text-[16px] font-semibold">{title}</h2>
      {description && <p className="text-text-tertiary text-[12px] mt-1">{description}</p>}
    </header>
  );
}

export function PageSection({ title, description, children }: SectionProps) {
  return (
    <section className="mb-6">
      <h3 className="text-text-primary text-[13px] font-semibold mb-1">{title}</h3>
      {description && <p className="text-text-tertiary text-[11.5px] mb-2">{description}</p>}
      <div className="bg-elevation-1 rounded-md ring-1 ring-[var(--ij-divider-soft)] px-3 py-1">
        {children}
      </div>
    </section>
  );
}
