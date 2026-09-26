/**
 * Apple "Liquid Glass" style circular loader: a still glass bead with a fixed
 * specular highlight and an accent arc rotating inside its rim. Styles live in
 * index.css (.ct-glass-spinner) so the global reduce-motion setting applies.
 * Decorative - pair it with visible text or pass `label` for screen readers.
 */
export function GlassSpinner({ size = 14, label, className = '' }: {
  size?: number;
  label?: string;
  className?: string;
}) {
  const ring = Math.max(1.5, Math.round(size / 7));
  return (
    <span
      className={`ct-glass-spinner ${className}`}
      style={{ width: size, height: size, ['--ring' as string]: `${ring}px` }}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
