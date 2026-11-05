export interface StatTile { label: string; value: string; tone?: 'ok' | 'bad' }

export function StatTiles({ tiles }: { tiles: StatTile[] }) {
  if (tiles.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="stat-tiles">
      {tiles.map((t) => (
        <div key={t.label} className="min-w-[64px] rounded-md bg-elevation-1 border border-seam px-2 py-1">
          <div
            className={`text-[13px] font-medium leading-tight ${
              t.tone === 'bad' ? 'text-red-400' : t.tone === 'ok' ? 'text-green-400' : 'text-text-primary'
            }`}
          >
            {t.value}
          </div>
          <div className="text-[10px] text-text-tertiary leading-tight">{t.label}</div>
        </div>
      ))}
    </div>
  );
}
