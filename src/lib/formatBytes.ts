// Human-readable download sizes for the update sheet. Decimal units (1000,
// not 1024) because that is what macOS Finder, the browser and the GitHub
// release page all report - a user comparing our "18.4 MB" against the asset
// listing should see the same number.

const KB = 1_000;
const MB = 1_000_000;
const GB = 1_000_000_000;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < KB) return `${Math.round(bytes)} B`;
  if (bytes < MB) return `${Math.round(bytes / KB)} KB`;
  if (bytes < GB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / GB).toFixed(1)} GB`;
}
