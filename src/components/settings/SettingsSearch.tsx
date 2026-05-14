import { Search } from 'lucide-react';

interface Props {
  value: string;
  onChange: (v: string) => void;
}

export function SettingsSearch({ value, onChange }: Props) {
  return (
    <div className="flex items-center bg-elevation-0 ring-1 ring-[var(--ij-divider-soft)] rounded-md px-2 h-7 w-[360px]">
      <Search size={12} className="text-text-tertiary mr-2" strokeWidth={1.75} />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search settings…"
        className="flex-1 bg-transparent text-[12px] text-text-primary placeholder:text-text-tertiary focus:outline-none"
      />
    </div>
  );
}
