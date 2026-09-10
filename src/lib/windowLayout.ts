import { getCurrentWindow } from '@tauri-apps/api/window';
import type { TerminalConfig } from '../store/terminalStore';

// Persisted map of detached windows so they can be reopened on next launch.
// Stored in localStorage (shared across this app's windows, same origin). Each
// window writes only its own entry via read-modify-write; writes are infrequent
// (tab changes, debounced move/resize, close) so races are unlikely.
const KEY = 'ct-window-layout';

export interface WindowGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface WindowEntry {
  sessionKeys: string[];
  geometry?: WindowGeometry;
}
type Layout = Record<string, WindowEntry>;

/** Saved terminal IDs identify tabs independently of conversation or directory. */
export function keyOf(cfg: Pick<TerminalConfig, 'id'>): string {
  return `tab:${cfg.id}`;
}

/** Legacy layout keys are usable only when they identify exactly one saved tab. */
export function restoreLayoutKeys(configs: Array<Pick<TerminalConfig, 'id' | 'claude_session_id' | 'working_directory'>>): string[][] {
  const legacy = configs.map(c => c.claude_session_id ? `sid:${c.claude_session_id}` : `cwd:${c.working_directory}`);
  const counts = new Map<string, number>();
  for (const key of legacy) counts.set(key, (counts.get(key) ?? 0) + 1);
  return configs.map((c, i) => [keyOf(c), ...(counts.get(legacy[i]) === 1 ? [legacy[i]] : [])]);
}

function read(): Layout {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const layout: Layout = Object.create(null);
    for (const [label, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const { sessionKeys, geometry } = value;
      if (!Array.isArray(sessionKeys) || !sessionKeys.every((key: unknown) => typeof key === 'string')) continue;
      const entry: WindowEntry = { sessionKeys };
      if (geometry && typeof geometry === 'object' &&
          [geometry.x, geometry.y, geometry.w, geometry.h].every(Number.isFinite) &&
          geometry.w > 0 && geometry.h > 0) {
        entry.geometry = { x: geometry.x, y: geometry.y, w: geometry.w, h: geometry.h };
      }
      layout[label] = entry;
    }
    return layout;
  } catch {
    return {};
  }
}
function write(layout: Layout) {
  try {
    localStorage.setItem(KEY, JSON.stringify(layout));
  } catch {
    /* storage full / unavailable - non-fatal */
  }
}

export function upsertEntry(label: string, entry: WindowEntry) {
  const l = read();
  l[label] = entry;
  write(l);
}

export function removeEntry(label: string) {
  const l = read();
  if (l[label]) {
    delete l[label];
    write(l);
  }
}

/** All persisted detached windows (the `main` window is never stored). */
export function getDetachedEntries(): Array<{ label: string; entry: WindowEntry }> {
  return Object.entries(read())
    .filter(([label]) => label !== 'main')
    .map(([label, entry]) => ({ label, entry }));
}

export async function currentGeometry(): Promise<WindowGeometry | undefined> {
  try {
    const win = getCurrentWindow();
    const pos = await win.outerPosition();
    const size = await win.outerSize();
    return { x: pos.x, y: pos.y, w: size.width, h: size.height };
  } catch {
    return undefined;
  }
}
