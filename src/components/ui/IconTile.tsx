import type { LucideIcon } from 'lucide-react';

/** Apple-style app-icon tiles: a white glyph on a glossy colour gradient. */
const TONES = {
  green:  'linear-gradient(180deg, #4CD964 0%, #23A047 100%)',
  orange: 'linear-gradient(180deg, #FFB340 0%, #FF7A00 100%)',
  purple: 'linear-gradient(180deg, #C77DFF 0%, #8E44D6 100%)',
  gray:   'linear-gradient(180deg, #A1A1A8 0%, #6B6B72 100%)',
  blue:   'linear-gradient(180deg, #5AB0FF 0%, #0A6CFF 100%)',
} as const;

export type IconTone = keyof typeof TONES;

export function IconTile({ icon: Icon, tone, size = 20 }: { icon: LucideIcon; tone: IconTone; size?: number }) {
  return (
    <span
      aria-hidden
      className="flex-shrink-0 flex items-center justify-center rounded-[6px] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.35),inset_0_-1px_0_rgba(0,0,0,0.15),0_1px_2px_rgba(0,0,0,0.25)]"
      style={{ width: size, height: size, background: TONES[tone] }}
    >
      <Icon size={Math.round(size * 0.6)} strokeWidth={2.2} />
    </span>
  );
}
