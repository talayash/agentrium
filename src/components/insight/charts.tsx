const MAX_BARS = 20;

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '');
}

export function BarChart({ items, max }: { items: { label: string; value: number }[]; max?: number }) {
  const shown = items.slice(0, MAX_BARS);
  const rowH = 20;
  const labelW = 110;
  const barW = 180;
  const valueW = 56;
  const width = labelW + barW + valueW;
  const height = Math.max(rowH, shown.length * rowH);
  const hasNeg = shown.some((i) => i.value < 0);
  const maxPos = Math.max(0, ...shown.map((i) => i.value));
  const maxNeg = Math.max(0, ...shown.map((i) => -i.value));
  const span = max ?? (maxPos + maxNeg || 1);
  const scale = barW / Math.max(span, 1e-9);
  const zeroX = labelW + (hasNeg ? maxNeg * scale : 0);
  const summary = shown.map((i) => `${i.label} ${fmt(i.value)}`).join(', ');

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Bar chart: ${summary}`}
      className="w-full max-w-md text-text-secondary"
    >
      {shown.map((it, idx) => {
        const y = idx * rowH;
        const w = Math.min(Math.abs(it.value) * scale, barW);
        const x = it.value < 0 ? zeroX - w : zeroX;
        return (
          <g key={idx}>
            <text x={labelW - 6} y={y + 14} textAnchor="end" fontSize="10" fill="currentColor">
              {it.label.length > 16 ? `${it.label.slice(0, 15)}...` : it.label}
            </text>
            <rect x={x} y={y + 4} width={w} height={rowH - 8} rx={2} fill="var(--accent-primary)" />
            <text x={labelW + barW + 4} y={y + 14} fontSize="10" fill="currentColor">
              {fmt(it.value)}
            </text>
          </g>
        );
      })}
      {hasNeg && <line x1={zeroX} x2={zeroX} y1={0} y2={height} stroke="currentColor" strokeOpacity={0.4} />}
    </svg>
  );
}

export function LineChart({ points }: { points: number[] }) {
  const w = 300;
  const h = 100;
  const pad = 14;
  const min = Math.min(...points);
  const maxV = Math.max(...points);
  const range = maxV - min || 1;
  const stepX = points.length > 1 ? (w - pad * 2) / (points.length - 1) : 0;
  const coords = points.map((p, i) => [pad + i * stepX, pad + (h - pad * 2) * (1 - (p - min) / range)]);
  const d = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={`Line chart of ${points.length} points, min ${fmt(min)}, max ${fmt(maxV)}, last ${fmt(points[points.length - 1])}`}
      className="w-full max-w-md text-text-secondary"
    >
      <path d={d} fill="none" stroke="var(--accent-primary)" strokeWidth={2} strokeLinejoin="round" />
      {coords.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={2} fill="var(--accent-primary)" />
      ))}
      <text x={2} y={10} fontSize="9" fill="currentColor">
        {fmt(maxV)}
      </text>
      <text x={2} y={h - 2} fontSize="9" fill="currentColor">
        {fmt(min)}
      </text>
    </svg>
  );
}
