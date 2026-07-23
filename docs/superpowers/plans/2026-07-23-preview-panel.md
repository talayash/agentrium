# Preview Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Base44/Lovable/Dyad-style right-docked live preview panel that auto-detects a terminal's dev-server URL and renders it in an iframe alongside the Claude Code terminal.

**Architecture:** Pure frontend detection (regex + `package.json` framework hint) wired into the existing `terminal-output` event listener; per-terminal state in a new Zustand slice; iframe rendered inside a new right-docked panel that reuses the app's existing dock pattern. Rust changes are limited to an additive `ConfigProfile.preview` field + a nullable `profiles.preview_json` column.

**Tech Stack:** React 18 + TypeScript + Zustand + Framer Motion (frontend). Rust + Tauri 2 + `rusqlite` (backend). Vitest (unit tests).

**Test approach:** Vitest for all pure functions (`allowlist`, `detector`, `framework`) and store lifecycle. Component tests via `@testing-library/react` **only** if it's already a dev dependency — otherwise stick to pure-fn tests + manual QA (following the project's existing pattern in `src/lib/*.test.ts`). Rust unit tests via `#[cfg(test)]` for `PreviewProfile` serde round-trip.

**Milestones:**
- **M1 — Foundation (Stage 1 from spec):** allow-list + detector + framework + store + basic iframe panel + `ToolStripe` toggle + `App.tsx` wiring. Ships as a working preview panel with manual URL entry.
- **M2 — URL bar + auto-detect UX (Stages 2-3):** toolbar with reload/external-open/URL bar, allow-list Settings, inline hint on ad-hoc detection, profile flag, Rust schema, terminalStore seeding. Ships as full "profiles that have GUI" experience.
- **M3 — Polish (Stages 4-7):** resize handle, device frames, back/forward, network-status pill, pop-out `WebviewWindow`. Task-level detail deferred to a follow-up plan drafted after M2 lands.

---

## File Structure

### New files (M1 + M2)

| Path | Responsibility |
|---|---|
| `src/lib/preview/allowlist.ts` | Pure `isUrlAllowed(url, allowList)`. Localhost variants always allowed; user globs matched with a small hand-rolled matcher. |
| `src/lib/preview/detector.ts` | Pure `detectUrl(text)`: ANSI-strip, regex match, most-recent-wins priority. |
| `src/lib/preview/framework.ts` | Pure `detectFramework(packageJson)`: priority `scripts.dev` > `dependencies` > `devDependencies`. Returns hint + default port. |
| `src/lib/preview/allowlist.test.ts` | Vitest. |
| `src/lib/preview/detector.test.ts` | Vitest with all 10 dev-server output fixtures from the spec. |
| `src/lib/preview/framework.test.ts` | Vitest with per-package fixtures. |
| `src/store/previewStore.ts` | Zustand slice for per-terminal preview state, allow-list, panel toggle, panel width. Partial persistence. |
| `src/store/previewStore.test.ts` | Vitest for lifecycle (seed/remove), override priority, keep-alive toggle. |
| `src/components/PreviewPanel.tsx` | The docked panel: header + iframe + resize handle (resize deferred to M3). |
| `src/components/PreviewToolbar.tsx` | URL bar, reload, external open, close. (M2) |
| `src/components/PreviewInlineHint.tsx` | Toast-style strip on ad-hoc detection. (M2) |
| `src/components/settings/PreviewSettingsSection.tsx` | Allow-list editor + `keepAliveAcrossTabs` toggle. (M2) |

### Modified files (M1 + M2)

| Path | Change |
|---|---|
| `src/App.tsx` | In the `terminal-output` listener, also call `previewDetector.consume(id, bytes)`. Mount `<PreviewPanel/>` in the right-panel dock area. |
| `src/components/ToolStripe.tsx` | Add "Preview" toggle icon on the right side. |
| `src/components/ProfileModal.tsx` | Add "Has GUI preview" checkbox + optional URL override input. (M2) |
| `src/hooks/useKeyboardShortcuts.ts` | Bind preview-toggle shortcut. Confirm free binding at implementation time. |
| `src/store/terminalStore.ts` | On `createTerminal`, seed `previewStore` (framework hint + profile). On `closeTerminal`, call `previewStore.removeTerminal(id)`. (M2) |
| `src-tauri/src/config.rs` | Add `PreviewProfile` struct + `preview: Option<PreviewProfile>` to `ConfigProfile`. (M2) |
| `src-tauri/src/database.rs` | Migration: add nullable `preview_json TEXT` column to `profiles` table. Serialize/deserialize on read/write. (M2) |
| `src-tauri/capabilities/default.json` | If `fs:read-text-file` isn't scoped to reach terminal `working_directory` for `package.json`, extend it. (M2) |
| `src/changelog.json` | Entry for the What's New modal after M2 lands. |

---

# MILESTONE 1 — Foundation

## Task 1: URL allow-list validation

**Files:**
- Create: `src/lib/preview/allowlist.ts`
- Test: `src/lib/preview/allowlist.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/preview/allowlist.test.ts
import { describe, expect, it } from 'vitest';
import { isUrlAllowed } from './allowlist';

describe('isUrlAllowed', () => {
  it('always allows localhost variants', () => {
    expect(isUrlAllowed('http://localhost:5173', [])).toBe(true);
    expect(isUrlAllowed('http://127.0.0.1:3000', [])).toBe(true);
    expect(isUrlAllowed('http://0.0.0.0:4321/', [])).toBe(true);
    expect(isUrlAllowed('https://localhost:8443', [])).toBe(true);
  });

  it('rejects arbitrary hostnames without allow-list entry', () => {
    expect(isUrlAllowed('http://evil.com', [])).toBe(false);
    expect(isUrlAllowed('https://example.org', [])).toBe(false);
  });

  it('allows hostnames matching allow-list glob', () => {
    expect(isUrlAllowed('https://abc.ngrok.io', ['*.ngrok.io'])).toBe(true);
    expect(isUrlAllowed('https://abc.def.ngrok.io', ['*.ngrok.io'])).toBe(false); // one label only
    expect(isUrlAllowed('https://foo.trycloudflare.com', ['*.trycloudflare.com'])).toBe(true);
  });

  it('rejects hostname-boundary tricks', () => {
    // '*.ngrok.io' must NOT match 'ngrok.io.evil.com'
    expect(isUrlAllowed('https://ngrok.io.evil.com', ['*.ngrok.io'])).toBe(false);
    expect(isUrlAllowed('https://evilngrok.io', ['*.ngrok.io'])).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(isUrlAllowed('not-a-url', [])).toBe(false);
    expect(isUrlAllowed('', [])).toBe(false);
    expect(isUrlAllowed('javascript:alert(1)', [])).toBe(false);
    expect(isUrlAllowed('file:///etc/passwd', [])).toBe(false);
  });

  it('only accepts http/https schemes', () => {
    expect(isUrlAllowed('ftp://localhost', [])).toBe(false);
    expect(isUrlAllowed('data:text/html,<h1>x</h1>', [])).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/preview/allowlist.test.ts`
Expected: FAIL — module `./allowlist` not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/preview/allowlist.ts
const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0']);

function hostMatchesGlob(host: string, pattern: string): boolean {
  // Only supports a single leading '*.' — 'foo.*' or 'a*b' are literal.
  if (!pattern.startsWith('*.')) {
    return host === pattern;
  }
  const suffix = pattern.slice(1); // '.ngrok.io'
  // Must end with suffix AND the prefix must be exactly one dotless label.
  if (!host.endsWith(suffix)) return false;
  const prefix = host.slice(0, host.length - suffix.length);
  return prefix.length > 0 && !prefix.includes('.');
}

export function isUrlAllowed(rawUrl: string, allowList: string[]): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (LOCALHOST_HOSTS.has(url.hostname)) return true;
  return allowList.some((p) => hostMatchesGlob(url.hostname, p));
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/lib/preview/allowlist.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/preview/allowlist.ts src/lib/preview/allowlist.test.ts
git commit -m "feat(preview): url allow-list validation (localhost + user globs)"
```

---

## Task 2: URL detector

**Files:**
- Create: `src/lib/preview/detector.ts`
- Test: `src/lib/preview/detector.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/preview/detector.test.ts
import { describe, expect, it } from 'vitest';
import { detectUrl } from './detector';

describe('detectUrl', () => {
  const cases: Array<[string, string, string | null]> = [
    ['Vite',       '➜  Local:   http://localhost:5173/',                        'http://localhost:5173'],
    ['Next.js 13', '- Local:        http://localhost:3000',                     'http://localhost:3000'],
    ['Next.js 15', '▲ Next.js 15.0.0\n- Local: http://localhost:3000',          'http://localhost:3000'],
    ['CRA',        'Local:            http://localhost:3000',                    'http://localhost:3000'],
    ['Astro',      '┃ Local    http://localhost:4321/',                          'http://localhost:4321'],
    ['Nuxt',       '➜ Local:    http://localhost:3000/',                         'http://localhost:3000'],
    ['SvelteKit',  '➜  Local:   http://localhost:5173/',                        'http://localhost:5173'],
    ['Angular',    'Angular Live Development Server is listening on localhost:4200', null], // no scheme
    ['Remix',      '[remix-serve] http://localhost:3000',                        'http://localhost:3000'],
    ['Expo web',   'Web is waiting on http://localhost:19006',                   'http://localhost:19006'],
  ];

  for (const [label, input, expected] of cases) {
    it(`detects ${label}`, () => {
      expect(detectUrl(input)).toBe(expected);
    });
  }

  it('strips ANSI escape codes before matching', () => {
    expect(detectUrl('\x1b[32m➜\x1b[39m  \x1b[1mLocal:\x1b[22m   \x1b[36mhttp://localhost:5173/\x1b[39m'))
      .toBe('http://localhost:5173');
  });

  it('returns most recent match when multiple are present', () => {
    const text = 'http://localhost:3000\nreloading...\nhttp://localhost:5173';
    expect(detectUrl(text)).toBe('http://localhost:5173');
  });

  it('returns null when nothing matches', () => {
    expect(detectUrl('nothing here')).toBe(null);
    expect(detectUrl('')).toBe(null);
  });

  it('handles Angular-style separately via detectHost helper (not required for M1)', () => {
    // Angular prints "listening on localhost:4200" without scheme. For M1 we
    // deliberately require a scheme. A future enhancement may add hostless
    // parsing behind a framework hint.
    expect(detectUrl('listening on localhost:4200')).toBe(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/preview/detector.test.ts`
Expected: FAIL — module `./detector` not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/preview/detector.ts
const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;
const URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{1,5})/gi;

const stripAnsi = (s: string): string => s.replace(ANSI_PATTERN, '');

function trimTrailing(url: string): string {
  // Drop trailing '/', punctuation, ANSI residue.
  return url.replace(/[\/,;.)\]]+$/, '');
}

export function detectUrl(text: string): string | null {
  if (!text) return null;
  const clean = stripAnsi(text);
  const matches = clean.match(URL_PATTERN);
  if (!matches || matches.length === 0) return null;
  return trimTrailing(matches[matches.length - 1]);
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/lib/preview/detector.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/preview/detector.ts src/lib/preview/detector.test.ts
git commit -m "feat(preview): dev-server url detector (10 framework fixtures)"
```

---

## Task 3: Framework detection from package.json

**Files:**
- Create: `src/lib/preview/framework.ts`
- Test: `src/lib/preview/framework.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/preview/framework.test.ts
import { describe, expect, it } from 'vitest';
import { detectFramework } from './framework';

describe('detectFramework', () => {
  it('detects Next.js from dependencies', () => {
    expect(detectFramework({ dependencies: { next: '^14.0.0' } })).toEqual({
      hint: 'nextjs', defaultPort: 3000,
    });
  });

  it('detects Vite from devDependencies', () => {
    expect(detectFramework({ devDependencies: { vite: '^5.0.0' } })).toEqual({
      hint: 'vite', defaultPort: 5173,
    });
  });

  it('prefers scripts.dev when it names a framework CLI', () => {
    // e.g. custom scripts.dev pointing at astro dev
    expect(detectFramework({
      scripts: { dev: 'astro dev' },
      dependencies: { vite: '^5.0.0' }, // vite is also present but astro wins from scripts
    })).toEqual({ hint: 'astro', defaultPort: 4321 });
  });

  it('returns unknown when nothing matches', () => {
    expect(detectFramework({ dependencies: { lodash: '^4.0.0' } })).toEqual({
      hint: 'unknown', defaultPort: null,
    });
  });

  it('returns unknown for empty object', () => {
    expect(detectFramework({})).toEqual({ hint: 'unknown', defaultPort: null });
  });

  it('handles all supported frameworks', () => {
    const cases: Array<[Record<string, unknown>, string, number]> = [
      [{ dependencies: { next: '*' } }, 'nextjs', 3000],
      [{ dependencies: { vite: '*' } }, 'vite', 5173],
      [{ dependencies: { '@angular/core': '*' } }, 'angular', 4200],
      [{ dependencies: { astro: '*' } }, 'astro', 4321],
      [{ dependencies: { nuxt: '*' } }, 'nuxt', 3000],
      [{ dependencies: { '@sveltejs/kit': '*' } }, 'sveltekit', 5173],
      [{ dependencies: { '@remix-run/dev': '*' } }, 'remix', 3000],
      [{ dependencies: { 'react-scripts': '*' } }, 'cra', 3000],
      [{ dependencies: { expo: '*' } }, 'expo', 8081],
    ];
    for (const [pkg, hint, port] of cases) {
      expect(detectFramework(pkg)).toEqual({ hint, defaultPort: port });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/preview/framework.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/lib/preview/framework.ts
export type FrameworkHint =
  | 'nextjs' | 'vite' | 'astro' | 'nuxt' | 'sveltekit' | 'remix'
  | 'angular' | 'cra' | 'expo' | 'unknown';

export interface FrameworkInfo {
  hint: FrameworkHint;
  defaultPort: number | null;
}

// Order matters: entries earlier in the list win ties. `scripts.dev` scan uses
// this array; dependencies scan iterates in the same order.
const FRAMEWORKS: Array<{ hint: FrameworkHint; pkg: string; cliToken: string; port: number }> = [
  { hint: 'nextjs',    pkg: 'next',              cliToken: 'next',       port: 3000  },
  { hint: 'astro',     pkg: 'astro',             cliToken: 'astro',      port: 4321  },
  { hint: 'nuxt',      pkg: 'nuxt',              cliToken: 'nuxt',       port: 3000  },
  { hint: 'sveltekit', pkg: '@sveltejs/kit',     cliToken: 'svelte',     port: 5173  },
  { hint: 'remix',     pkg: '@remix-run/dev',    cliToken: 'remix',      port: 3000  },
  { hint: 'angular',   pkg: '@angular/core',     cliToken: 'ng ',        port: 4200  },
  { hint: 'cra',       pkg: 'react-scripts',     cliToken: 'react-scripts', port: 3000 },
  { hint: 'expo',      pkg: 'expo',              cliToken: 'expo',       port: 8081  },
  { hint: 'vite',      pkg: 'vite',              cliToken: 'vite',       port: 5173  },
];

export function detectFramework(pkg: Record<string, unknown>): FrameworkInfo {
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  const devScript = typeof scripts.dev === 'string' ? scripts.dev.toLowerCase() : '';

  if (devScript) {
    for (const fw of FRAMEWORKS) {
      if (devScript.includes(fw.cliToken)) {
        return { hint: fw.hint, defaultPort: fw.port };
      }
    }
  }

  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) } as Record<string, unknown>;
  for (const fw of FRAMEWORKS) {
    if (fw.pkg in deps) {
      return { hint: fw.hint, defaultPort: fw.port };
    }
  }
  return { hint: 'unknown', defaultPort: null };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/lib/preview/framework.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/preview/framework.ts src/lib/preview/framework.test.ts
git commit -m "feat(preview): framework detection from package.json"
```

---

## Task 4: Preview Zustand store

**Files:**
- Create: `src/store/previewStore.ts`
- Test: `src/store/previewStore.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/store/previewStore.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { usePreviewStore } from './previewStore';

describe('previewStore', () => {
  beforeEach(() => {
    usePreviewStore.setState({
      perTerminal: new Map(),
      globalOpen: false,
      allowList: [],
      keepAliveAcrossTabs: false,
      panelWidthPx: 640,
    });
  });

  it('seeds a terminal with defaults', () => {
    usePreviewStore.getState().seedTerminal('t1', {});
    const s = usePreviewStore.getState().perTerminal.get('t1');
    expect(s).toBeDefined();
    expect(s?.detectedUrl).toBeNull();
    expect(s?.userOverride).toBeNull();
    expect(s?.frameworkHint).toBe('unknown');
    expect(s?.isOpen).toBe(false);
  });

  it('setDetectedUrl updates the state', () => {
    usePreviewStore.getState().seedTerminal('t1', {});
    usePreviewStore.getState().setDetectedUrl('t1', 'http://localhost:5173');
    expect(usePreviewStore.getState().perTerminal.get('t1')?.detectedUrl).toBe('http://localhost:5173');
  });

  it('userOverride wins over detectedUrl in resolveUrl', () => {
    usePreviewStore.getState().seedTerminal('t1', {});
    usePreviewStore.getState().setDetectedUrl('t1', 'http://localhost:5173');
    usePreviewStore.getState().setUserOverride('t1', 'http://localhost:3000');
    // Consumers call resolveUrl to get the effective URL
    const { resolveUrl } = usePreviewStore.getState();
    expect(resolveUrl('t1')).toBe('http://localhost:3000');
  });

  it('resolveUrl falls back to detectedUrl when no override', () => {
    usePreviewStore.getState().seedTerminal('t1', {});
    usePreviewStore.getState().setDetectedUrl('t1', 'http://localhost:5173');
    expect(usePreviewStore.getState().resolveUrl('t1')).toBe('http://localhost:5173');
  });

  it('resolveUrl returns null when nothing is set', () => {
    usePreviewStore.getState().seedTerminal('t1', {});
    expect(usePreviewStore.getState().resolveUrl('t1')).toBeNull();
  });

  it('removeTerminal drops per-terminal state', () => {
    usePreviewStore.getState().seedTerminal('t1', {});
    usePreviewStore.getState().removeTerminal('t1');
    expect(usePreviewStore.getState().perTerminal.has('t1')).toBe(false);
  });

  it('toggleGlobal flips globalOpen', () => {
    expect(usePreviewStore.getState().globalOpen).toBe(false);
    usePreviewStore.getState().toggleGlobal();
    expect(usePreviewStore.getState().globalOpen).toBe(true);
    usePreviewStore.getState().toggleGlobal();
    expect(usePreviewStore.getState().globalOpen).toBe(false);
  });

  it('reload bumps reloadCounter', () => {
    usePreviewStore.getState().seedTerminal('t1', {});
    const before = usePreviewStore.getState().perTerminal.get('t1')?.reloadCounter ?? 0;
    usePreviewStore.getState().reload('t1');
    const after = usePreviewStore.getState().perTerminal.get('t1')?.reloadCounter ?? 0;
    expect(after).toBe(before + 1);
  });

  it('addToAllowList deduplicates', () => {
    usePreviewStore.getState().addToAllowList('*.ngrok.io');
    usePreviewStore.getState().addToAllowList('*.ngrok.io');
    expect(usePreviewStore.getState().allowList.filter((p) => p === '*.ngrok.io')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/previewStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/store/previewStore.ts
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { FrameworkHint } from '../lib/preview/framework';

export type DeviceName = 'desktop' | 'tablet' | 'mobile';
export interface DeviceMode { name: DeviceName; width: number; height?: number }

export const DEVICE_MODES: Record<DeviceName, DeviceMode> = {
  desktop: { name: 'desktop', width: 0 }, // 0 = full width
  tablet:  { name: 'tablet',  width: 768,  height: 1024 },
  mobile:  { name: 'mobile',  width: 375,  height: 812  },
};

export interface PreviewState {
  isOpen: boolean;
  detectedUrl: string | null;
  userOverride: string | null;
  frameworkHint: FrameworkHint;
  deviceMode: DeviceMode;
  history: string[];
  historyIndex: number;
  lastError: string | null;
  reloadCounter: number;
  inlineHintDismissed: boolean;
}

const defaultPreviewState = (): PreviewState => ({
  isOpen: false,
  detectedUrl: null,
  userOverride: null,
  frameworkHint: 'unknown',
  deviceMode: DEVICE_MODES.desktop,
  history: [],
  historyIndex: -1,
  lastError: null,
  reloadCounter: 0,
  inlineHintDismissed: false,
});

interface PreviewStoreState {
  perTerminal: Map<string, PreviewState>;
  globalOpen: boolean;
  allowList: string[];
  keepAliveAcrossTabs: boolean;
  panelWidthPx: number;

  seedTerminal(id: string, initial: Partial<PreviewState>): void;
  setDetectedUrl(id: string, url: string): void;
  setUserOverride(id: string, url: string): void;
  dismissInlineHint(id: string): void;
  markOpen(id: string, open: boolean): void;
  removeTerminal(id: string): void;
  toggleGlobal(): void;
  setDeviceMode(id: string, mode: DeviceMode): void;
  reload(id: string): void;
  addToAllowList(pattern: string): void;
  removeFromAllowList(pattern: string): void;
  setPanelWidth(px: number): void;
  setKeepAliveAcrossTabs(v: boolean): void;
  resolveUrl(id: string): string | null;
}

function withMutatedTerminal(
  set: (fn: (s: PreviewStoreState) => Partial<PreviewStoreState>) => void,
  id: string,
  mutator: (s: PreviewState) => PreviewState,
) {
  set((state) => {
    const next = new Map(state.perTerminal);
    const cur = next.get(id) ?? defaultPreviewState();
    next.set(id, mutator(cur));
    return { perTerminal: next };
  });
}

export const usePreviewStore = create<PreviewStoreState>()(
  persist(
    (set, get) => ({
      perTerminal: new Map(),
      globalOpen: false,
      allowList: [],
      keepAliveAcrossTabs: false,
      panelWidthPx: 640,

      seedTerminal: (id, initial) =>
        withMutatedTerminal(set, id, (s) => ({ ...s, ...initial })),

      setDetectedUrl: (id, url) =>
        withMutatedTerminal(set, id, (s) => ({ ...s, detectedUrl: url, lastError: null })),

      setUserOverride: (id, url) =>
        withMutatedTerminal(set, id, (s) => ({ ...s, userOverride: url })),

      dismissInlineHint: (id) =>
        withMutatedTerminal(set, id, (s) => ({ ...s, inlineHintDismissed: true })),

      markOpen: (id, open) =>
        withMutatedTerminal(set, id, (s) => ({ ...s, isOpen: open })),

      removeTerminal: (id) =>
        set((state) => {
          const next = new Map(state.perTerminal);
          next.delete(id);
          return { perTerminal: next };
        }),

      toggleGlobal: () => set((s) => ({ globalOpen: !s.globalOpen })),

      setDeviceMode: (id, mode) =>
        withMutatedTerminal(set, id, (s) => ({ ...s, deviceMode: mode })),

      reload: (id) =>
        withMutatedTerminal(set, id, (s) => ({ ...s, reloadCounter: s.reloadCounter + 1 })),

      addToAllowList: (pattern) =>
        set((s) => (s.allowList.includes(pattern)
          ? s
          : { allowList: [...s.allowList, pattern] })),

      removeFromAllowList: (pattern) =>
        set((s) => ({ allowList: s.allowList.filter((p) => p !== pattern) })),

      setPanelWidth: (px) => set({ panelWidthPx: Math.max(320, Math.min(1400, px)) }),
      setKeepAliveAcrossTabs: (v) => set({ keepAliveAcrossTabs: v }),

      resolveUrl: (id) => {
        const s = get().perTerminal.get(id);
        if (!s) return null;
        return s.userOverride ?? s.detectedUrl;
      },
    }),
    {
      name: 'preview-store',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        globalOpen: s.globalOpen,
        allowList: s.allowList,
        keepAliveAcrossTabs: s.keepAliveAcrossTabs,
        panelWidthPx: s.panelWidthPx,
      }),
    },
  ),
);
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/store/previewStore.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/store/previewStore.ts src/store/previewStore.test.ts
git commit -m "feat(preview): zustand store (per-terminal state, allow-list, persist)"
```

---

## Task 5: PreviewPanel component (M1 minimum)

**Files:**
- Create: `src/components/PreviewPanel.tsx`

- [ ] **Step 1: Implement the minimal panel**

The panel renders when `globalOpen && activeTerminalId && resolvedUrl` are all truthy. If the resolved URL is not allow-listed, render a blocked-state placeholder. Reload is triggered by remounting the iframe when `reloadCounter` changes (key trick).

```tsx
// src/components/PreviewPanel.tsx
import { useMemo } from 'react';
import { useTerminalStore } from '../store/terminalStore';
import { usePreviewStore } from '../store/previewStore';
import { isUrlAllowed } from '../lib/preview/allowlist';

export function PreviewPanel() {
  const activeId = useTerminalStore((s) => s.activeTerminalId);
  const globalOpen = usePreviewStore((s) => s.globalOpen);
  const panelWidthPx = usePreviewStore((s) => s.panelWidthPx);
  const allowList = usePreviewStore((s) => s.allowList);
  const perTerminal = usePreviewStore((s) => s.perTerminal);
  const resolveUrl = usePreviewStore((s) => s.resolveUrl);

  const url = activeId ? resolveUrl(activeId) : null;
  const state = activeId ? perTerminal.get(activeId) : undefined;
  const reloadCounter = state?.reloadCounter ?? 0;

  const allowed = useMemo(
    () => (url ? isUrlAllowed(url, allowList) : false),
    [url, allowList],
  );

  if (!globalOpen || !activeId) return null;

  return (
    <div
      className="h-full flex flex-col bg-bg-secondary border-l border-white/[0.06] overflow-hidden"
      style={{ width: panelWidthPx }}
      data-testid="preview-panel"
    >
      <div className="px-3 py-2 border-b border-white/[0.06] flex items-center justify-between shrink-0">
        <div className="text-text-primary text-[12px] font-medium">Preview</div>
        <div className="text-text-tertiary text-[11px] truncate max-w-[65%]">
          {url ?? 'no url'}
        </div>
      </div>

      <div className="flex-1 relative bg-black">
        {!url && (
          <div className="absolute inset-0 flex items-center justify-center text-text-tertiary text-[12px]">
            Waiting for a dev-server URL…
          </div>
        )}
        {url && !allowed && (
          <div className="absolute inset-0 flex items-center justify-center text-center p-6">
            <div className="max-w-sm">
              <div className="text-text-primary text-[13px] font-semibold mb-1">
                URL not allowed
              </div>
              <div className="text-text-tertiary text-[11.5px]">
                <code className="text-text-secondary">{url}</code> is outside the preview allow-list.
                Add it in Settings → Preview.
              </div>
            </div>
          </div>
        )}
        {url && allowed && (
          <iframe
            key={`${url}#${reloadCounter}`}
            src={url}
            title="Preview"
            className="absolute inset-0 w-full h-full border-0"
          />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add src/components/PreviewPanel.tsx
git commit -m "feat(preview): minimal PreviewPanel component (iframe + blocked state)"
```

---

## Task 6: Wire detector into App.tsx and mount PreviewPanel

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Locate the `terminal-output` listener**

The listener currently lives around `src/App.tsx:415`. Read it first to confirm the shape:
```
const unlisten = listen<{ id: string; data: number[] }>('terminal-output', (event) => {
  const { id, data } = event.payload;
  handleTerminalOutput(id, new Uint8Array(data));
  ...
});
```

- [ ] **Step 2: Add detector import at top of file (with the other lib imports)**

```tsx
import { detectUrl } from './lib/preview/detector';
import { usePreviewStore } from './store/previewStore';
```

Also add `PreviewPanel` to the component imports:

```tsx
import { PreviewPanel } from './components/PreviewPanel';
```

- [ ] **Step 3: Add detector call inside the existing `terminal-output` listener**

Modify the existing effect so that AFTER `handleTerminalOutput(id, new Uint8Array(data));` it also runs:

```tsx
try {
  const text = new TextDecoder().decode(new Uint8Array(data));
  const found = detectUrl(text);
  if (found) {
    const cur = usePreviewStore.getState().perTerminal.get(id);
    if (cur?.detectedUrl !== found) {
      usePreviewStore.getState().setDetectedUrl(id, found);
    }
  }
} catch { /* ignore decode errors */ }
```

Place it right after the existing `loopMatch` detection block. The `TextDecoder` allocation per chunk is fine — the loop-mode detector already does the same thing on the line above.

- [ ] **Step 4: Mount `<PreviewPanel/>` in the dock area**

Inside the right-side panel `AnimatePresence` cluster (after `<HintsPanel/>`, before `<ToolStripe side="right"/>`), add:

```tsx
<PreviewPanel />
```

`PreviewPanel` handles its own visibility (returns null unless `globalOpen && activeId`), so wrapping it in another `AnimatePresence` is unnecessary — but ensure it renders BETWEEN the other right-docked panels and the right-side `<ToolStripe/>` so it stacks correctly.

- [ ] **Step 5: Type check + smoke build**

Run: `npx tsc --noEmit && npx vite build`
Expected: no TS errors, build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx
git commit -m "feat(preview): wire url detector into terminal-output stream + mount panel"
```

---

## Task 7: ToolStripe toggle icon + keyboard shortcut

**Files:**
- Modify: `src/components/ToolStripe.tsx`
- Modify: `src/hooks/useKeyboardShortcuts.ts`

- [ ] **Step 1: Read `ToolStripe.tsx` to find existing toggle pattern**

Look for how `changesOpen`, `hintsOpen`, `orchestrationOpen` toggles are rendered on the right side. Match the pattern (icon, tooltip, click handler).

- [ ] **Step 2: Add a Preview toggle**

Import `usePreviewStore`. On the right side, add a button that:
- Icon: use a "monitor" or "eye" icon from `lucide-react` (already a dep). `Monitor` is the natural choice.
- Tooltip: `Preview (Ctrl+Shift+V)` — final shortcut confirmed in Step 4.
- Active state: `globalOpen === true` renders with the same active styling as sibling toggles.
- onClick: `usePreviewStore.getState().toggleGlobal()`.

Follow the exact JSX pattern of the adjacent toggle. This is a small mechanical edit — don't refactor surrounding code.

- [ ] **Step 3: Type check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Wire shortcut**

Read `src/hooks/useKeyboardShortcuts.ts` first. Find the block that maps keys → handlers.

Add a new binding. Preference order (use the first free one):
- `Ctrl+Shift+V`
- `Ctrl+Shift+G`
- `Ctrl+Alt+P`

Handler: `usePreviewStore.getState().toggleGlobal()`.

If none of the three are free (very unlikely), pick another modifier combo and note the choice in the commit message.

- [ ] **Step 5: Commit**

```bash
git add src/components/ToolStripe.tsx src/hooks/useKeyboardShortcuts.ts
git commit -m "feat(preview): ToolStripe toggle + Ctrl+Shift+V shortcut"
```

---

## Task 8: M1 verification

- [ ] **Step 1: Full type + build**

Run: `npx tsc --noEmit && npx vite build`
Expected: PASS.

- [ ] **Step 2: All tests**

Run: `npx vitest run`
Expected: existing suite green + 4 new files (allowlist, detector, framework, previewStore) contribute ~35 new tests, all passing.

- [ ] **Step 3: Manual QA in a scratch Vite project (or existing one)**

Because the Tauri dev app can't be automated (see project memory), verify by hand:

1. Launch `npm run tauri dev`.
2. Create a terminal in any Vite project. Run `npm run dev`. 
3. Toggle preview via `ToolStripe` icon or `Ctrl+Shift+V`. Panel should appear on the right.
4. Once Vite prints `➜  Local: http://localhost:5173/`, the iframe should populate within one output chunk.
5. Switch to another (non-web) terminal. Preview panel should show "Waiting for a dev-server URL…"
6. Switch back. iframe should re-mount with the same URL (`reloadCounter` unchanged → same `key`).
7. Try setting `allowList = []` and pointing a manual override at `https://example.com` — should show the "URL not allowed" blocked state.

- [ ] **Step 4: M1 tag commit**

```bash
git commit --allow-empty -m "chore(preview): M1 foundation shipped — panel + detector + toggle"
```

---

# MILESTONE 2 — URL bar + auto-detect UX + profile flag

## Task 9: PreviewToolbar with URL bar, reload, external open

**Files:**
- Create: `src/components/PreviewToolbar.tsx`
- Modify: `src/components/PreviewPanel.tsx` (replace the plain header with the toolbar)

- [ ] **Step 1: Implement toolbar**

```tsx
// src/components/PreviewToolbar.tsx
import { useEffect, useState } from 'react';
import { RotateCw, ExternalLink, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { usePreviewStore } from '../store/previewStore';
import { isUrlAllowed } from '../lib/preview/allowlist';

interface Props { terminalId: string; url: string | null; allowed: boolean }

export function PreviewToolbar({ terminalId, url, allowed }: Props) {
  const allowList = usePreviewStore((s) => s.allowList);
  const setUserOverride = usePreviewStore((s) => s.setUserOverride);
  const reload = usePreviewStore((s) => s.reload);
  const toggleGlobal = usePreviewStore((s) => s.toggleGlobal);

  const [draft, setDraft] = useState(url ?? '');
  const [invalid, setInvalid] = useState(false);

  useEffect(() => { setDraft(url ?? ''); setInvalid(false); }, [url]);

  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (!isUrlAllowed(trimmed, allowList)) { setInvalid(true); return; }
    setUserOverride(terminalId, trimmed);
  };

  const openExternal = () => { if (url && allowed) void invoke('open_external_url', { url }); };

  return (
    <div className="px-2 py-1.5 border-b border-white/[0.06] flex items-center gap-1.5 shrink-0">
      <button
        onClick={() => reload(terminalId)}
        disabled={!url}
        className="p-1 rounded hover:bg-white/[0.05] text-text-secondary disabled:opacity-40"
        title="Reload"
      >
        <RotateCw size={14} />
      </button>
      <input
        value={draft}
        onChange={(e) => { setDraft(e.target.value); setInvalid(false); }}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
        onBlur={commit}
        spellCheck={false}
        placeholder="http://localhost:5173"
        className={`flex-1 bg-elevation-2 border rounded px-2 py-1 text-[11.5px] text-text-primary outline-none ${
          invalid ? 'border-red-500/60' : 'border-white/[0.06] focus:border-accent-primary/60'
        }`}
      />
      <button
        onClick={openExternal}
        disabled={!url || !allowed}
        className="p-1 rounded hover:bg-white/[0.05] text-text-secondary disabled:opacity-40"
        title="Open in browser"
      >
        <ExternalLink size={14} />
      </button>
      <button
        onClick={toggleGlobal}
        className="p-1 rounded hover:bg-white/[0.05] text-text-secondary"
        title="Close preview"
      >
        <X size={14} />
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Replace the plain header in `PreviewPanel.tsx`**

Delete the current `<div className="px-3 py-2 border-b ...">` block. Import and render `<PreviewToolbar terminalId={activeId} url={url} allowed={allowed}/>` in its place.

- [ ] **Step 3: Type check + build**

Run: `npx tsc --noEmit && npx vite build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/PreviewToolbar.tsx src/components/PreviewPanel.tsx
git commit -m "feat(preview): toolbar (url bar + reload + external open + close)"
```

---

## Task 10: Rust `PreviewProfile`

**Files:**
- Modify: `src-tauri/src/config.rs`

- [ ] **Step 1: Read current `ConfigProfile` to match style**

Understand the existing derives and field visibility.

- [ ] **Step 2: Add the struct + field**

```rust
// src-tauri/src/config.rs (append below existing structs, add field to ConfigProfile)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct PreviewProfile {
    pub enabled: bool,
    pub url_override: Option<String>,
    pub framework_hint: Option<String>,
}

// In ConfigProfile — add this field, keeping serde defaults so old rows keep parsing:
// #[serde(default)]
// pub preview: Option<PreviewProfile>,
```

Place the field near the end of `ConfigProfile` and mark it `#[serde(default)]` so profiles serialized before this change deserialize with `preview: None`.

- [ ] **Step 3: Add a round-trip test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_profile_default_and_roundtrip() {
        let p = PreviewProfile { enabled: true, url_override: Some("http://localhost:3000".into()), framework_hint: Some("vite".into()) };
        let json = serde_json::to_string(&p).unwrap();
        let back: PreviewProfile = serde_json::from_str(&json).unwrap();
        assert_eq!(back.enabled, true);
        assert_eq!(back.url_override.as_deref(), Some("http://localhost:3000"));
    }
    #[test]
    fn missing_preview_deserializes_as_none_on_config_profile() {
        // Simulate an old serialized ConfigProfile without the preview field.
        let json = r#"{"name":"x","working_directory":"/tmp","claude_args":[],"env_vars":{}}"#;
        let cfg: ConfigProfile = serde_json::from_str(json).unwrap();
        assert!(cfg.preview.is_none());
    }
}
```

Note: the second test requires that all other fields have serde defaults or are still present in the JSON above. If `ConfigProfile` has additional non-defaultable fields (e.g. `id`, timestamps), extend the JSON accordingly — but the field being tested is `preview`, so keep the fixture minimal.

- [ ] **Step 4: Run Rust tests**

Run: `cd src-tauri && cargo test preview_profile -- --nocapture`
Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/config.rs
git commit -m "feat(preview): ConfigProfile.preview (backwards-compatible via serde default)"
```

---

## Task 11: DB migration for `preview_json` column

**Files:**
- Modify: `src-tauri/src/database.rs`

- [ ] **Step 1: Read the current profiles table schema**

Find the `CREATE TABLE IF NOT EXISTS profiles (...)` block and the profile read/write functions.

- [ ] **Step 2: Add migration**

Add to the schema init: `preview_json TEXT` column with default NULL. Because SQLite allows `ALTER TABLE ADD COLUMN` at any time and this is additive, follow the existing migration pattern in `database.rs`. If the project already has a migration versioning system (e.g. `PRAGMA user_version`), add a new migration step. Otherwise use `ALTER TABLE profiles ADD COLUMN preview_json TEXT` inside a defensive `let _ = ...;` (SQLite raises if the column exists — swallow that specific error).

- [ ] **Step 3: Update profile serialization**

- On save: `serde_json::to_string(&profile.preview).ok()` → `preview_json` column (NULL if `None`).
- On load: read `preview_json`; if non-null, `serde_json::from_str::<Option<PreviewProfile>>` → assign.
- Follow existing `env_vars` serialization pattern (it's already stored as JSON in a TEXT column).

- [ ] **Step 4: Rust test**

Add a test that saves a profile with `preview: Some(...)`, reads it back, and confirms round-trip equality.

- [ ] **Step 5: Run tests**

Run: `cd src-tauri && cargo test`
Expected: existing suite + new test PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/database.rs
git commit -m "feat(preview): sqlite profiles.preview_json column + round-trip"
```

---

## Task 12: ProfileModal — "Has GUI preview" checkbox

**Files:**
- Modify: `src/components/ProfileModal.tsx`

- [ ] **Step 1: Read the modal to find where to add fields**

Locate the form section — likely a series of labeled inputs. Match the visual pattern.

- [ ] **Step 2: Add fields**

- A `<label>` with a checkbox "Has GUI preview" bound to `profile.preview?.enabled`.
- When checked, reveal an optional `<input>` "Preview URL (optional override)" bound to `profile.preview?.url_override`.
- Save handler serializes into a `preview: PreviewProfile | undefined` field on the profile before invoking `save_profile`.

Keep changes surgical — don't refactor unrelated fields.

- [ ] **Step 3: Type check + build**

Run: `npx tsc --noEmit && npx vite build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/ProfileModal.tsx
git commit -m "feat(preview): ProfileModal 'Has GUI preview' checkbox + url override"
```

---

## Task 13: PreviewInlineHint

**Files:**
- Create: `src/components/PreviewInlineHint.tsx`
- Modify: `src/App.tsx` (mount it)

- [ ] **Step 1: Implement hint**

```tsx
// src/components/PreviewInlineHint.tsx
import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTerminalStore } from '../store/terminalStore';
import { usePreviewStore } from '../store/previewStore';

const AUTO_DISMISS_MS = 6000;

export function PreviewInlineHint() {
  const activeId = useTerminalStore((s) => s.activeTerminalId);
  const globalOpen = usePreviewStore((s) => s.globalOpen);
  const perTerminal = usePreviewStore((s) => s.perTerminal);
  const dismissInlineHint = usePreviewStore((s) => s.dismissInlineHint);
  const toggleGlobal = usePreviewStore((s) => s.toggleGlobal);

  const state = activeId ? perTerminal.get(activeId) : undefined;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!state || globalOpen) { setVisible(false); return; }
    if (state.inlineHintDismissed) { setVisible(false); return; }
    if (!state.detectedUrl) { setVisible(false); return; }
    setVisible(true);
    const t = setTimeout(() => { if (activeId) dismissInlineHint(activeId); }, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [state?.detectedUrl, state?.inlineHintDismissed, globalOpen, activeId, dismissInlineHint, state]);

  const url = state?.detectedUrl;
  return (
    <AnimatePresence>
      {visible && activeId && url && (
        <motion.div
          initial={{ y: 24, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 24, opacity: 0 }}
          className="fixed bottom-8 right-6 z-50 bg-elevation-3 ring-1 ring-white/[0.08] rounded-md shadow-lg px-3 py-2 flex items-center gap-2"
        >
          <span className="text-text-secondary text-[12px]">
            Detected <code className="text-text-primary">{url}</code>
          </span>
          <button
            onClick={() => { toggleGlobal(); dismissInlineHint(activeId); }}
            className="text-[12px] font-medium text-accent-primary hover:text-accent-secondary"
          >
            Open preview
          </button>
          <button
            onClick={() => dismissInlineHint(activeId)}
            className="text-[12px] text-text-tertiary hover:text-text-secondary"
          >
            Dismiss
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
```

- [ ] **Step 2: Mount in `App.tsx`**

Add `<PreviewInlineHint/>` alongside `<ToastContainer/>` near the end of the root layout.

- [ ] **Step 3: Type check + build**

Run: `npx tsc --noEmit && npx vite build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/PreviewInlineHint.tsx src/App.tsx
git commit -m "feat(preview): inline hint on ad-hoc dev-server detection"
```

---

## Task 14: terminalStore seeding + cleanup

**Files:**
- Modify: `src/store/terminalStore.ts`

- [ ] **Step 1: On `createTerminal`, seed the preview store**

Inside `createTerminal` (after the terminal instance is created in the store), read the profile if the caller passed one (or reconstruct minimal state), then:

```ts
import { usePreviewStore } from './previewStore';
// ...inside createTerminal, right after adding the new instance to the map:
const previewInit = {
  isOpen: profile?.preview?.enabled ?? false,
  frameworkHint: (profile?.preview?.framework_hint as FrameworkHint | undefined) ?? 'unknown',
  userOverride: profile?.preview?.url_override ?? null,
};
usePreviewStore.getState().seedTerminal(newId, previewInit);
// If profile.preview.enabled, open the panel too:
if (profile?.preview?.enabled && !usePreviewStore.getState().globalOpen) {
  usePreviewStore.getState().toggleGlobal();
}
```

Note: `createTerminal` in this codebase may not currently accept a full `profile` — check the signature. If not, thread the `preview` block through by adding a small optional parameter, or read it from an in-memory profile cache. Don't over-engineer; a minimal `previewInit?: Partial<PreviewState>` param works if profile plumbing is deep.

- [ ] **Step 2: On `closeTerminal`, drop preview state**

```ts
usePreviewStore.getState().removeTerminal(id);
```

Place inside `closeTerminal` right after the terminal is removed from the store map, mirroring the existing `unreadTerminalIds` cleanup.

- [ ] **Step 3: Type check + build**

Run: `npx tsc --noEmit && npx vite build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/store/terminalStore.ts
git commit -m "feat(preview): seed store on createTerminal, cleanup on close"
```

---

## Task 15: Framework hint from package.json on terminal create

**Files:**
- Modify: `src/store/terminalStore.ts`

- [ ] **Step 1: Add a helper**

In `terminalStore.ts` (or a new tiny helper file), add a fire-and-forget async function that reads `<cwd>/package.json` via `@tauri-apps/plugin-fs` and calls `usePreviewStore.getState().seedTerminal(id, { frameworkHint })`.

```ts
import { readTextFile } from '@tauri-apps/plugin-fs';
import { detectFramework } from '../lib/preview/framework';

async function seedFrameworkHint(terminalId: string, cwd: string) {
  try {
    const raw = await readTextFile(`${cwd}/package.json`);
    const pkg = JSON.parse(raw);
    const { hint } = detectFramework(pkg);
    if (hint !== 'unknown') {
      usePreviewStore.getState().seedTerminal(terminalId, { frameworkHint: hint });
    }
  } catch { /* no package.json, or unreadable — silent */ }
}
```

Call `void seedFrameworkHint(newId, workingDirectory);` right after the initial `seedTerminal` call from Task 14.

- [ ] **Step 2: Verify capability**

Check `src-tauri/capabilities/default.json`. Ensure `fs:read-text-file` or the equivalent permission covers reading files under the terminal's working directory. If it does not, extend the capability to allow reading `**/package.json` scoped to user home / project dirs.

- [ ] **Step 3: Type check + build**

Run: `npx tsc --noEmit && npx vite build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/store/terminalStore.ts src-tauri/capabilities/default.json
git commit -m "feat(preview): seed framework hint from package.json on terminal create"
```

---

## Task 16: Preview settings section

**Files:**
- Create: `src/components/settings/PreviewSettingsSection.tsx`
- Modify: the settings window / navigator to include the new section.

- [ ] **Step 1: Implement section**

- Header: "Preview".
- List of allow-list entries with per-row Delete button.
- Input + "Add" button for new patterns (e.g. `*.ngrok.io`). Validate that the pattern is non-empty; `*.hostname.tld` is the only supported shape (documented in a tiny help line).
- Toggle: "Keep preview alive across tab switches" (bound to `keepAliveAcrossTabs`).

Reuse existing settings-section styling from an adjacent section (e.g. Notifications).

- [ ] **Step 2: Wire into settings navigator**

Read `src/components/settings/SettingsWindow.tsx` (or wherever section navigation lives) and add "Preview" as a new entry pointing at `PreviewSettingsSection`.

- [ ] **Step 3: Type check + build**

Run: `npx tsc --noEmit && npx vite build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/PreviewSettingsSection.tsx src/components/settings/SettingsWindow.tsx
git commit -m "feat(preview): settings section (allow-list + keep-alive toggle)"
```

---

## Task 17: M2 verification + changelog

- [ ] **Step 1: Full type + build**

Run: `npx tsc --noEmit && npx vite build && npx vitest run && cd src-tauri && cargo test`
Expected: everything green.

- [ ] **Step 2: Manual QA**

1. Create a profile with "Has GUI preview" checked and URL override `http://localhost:3000`. Launch a terminal from that profile in a Next.js project. Verify: preview panel opens automatically, iframe loads override URL immediately.
2. In the same terminal, run `npm run dev`. Once Next prints its URL, verify the panel keeps the user override (override wins over detected).
3. Uncheck override, restart. Confirm detected URL fills in automatically after `npm run dev`.
4. Open a non-GUI-profile terminal, run `npm run dev` in a Vite project. Verify inline hint appears within a few seconds. Click "Open preview" — panel opens, hint dismisses.
5. Enter `https://example.com` in the URL bar. Panel shows blocked state. Add `example.com` to the allow-list in Settings. URL now loads.
6. Close the terminal. Verify no console errors — state is dropped.
7. Restart the app. Confirm `allowList` and `panelWidthPx` persist; `perTerminal` does not.

- [ ] **Step 3: Changelog entry**

Add to `src/changelog.json` a new top entry for the next version — sample text:

```json
{
  "version": "1.28.0",
  "date": "2026-07-23",
  "title": "Live preview for GUI projects",
  "items": [
    "New right-docked Preview panel with auto-detected dev-server URL (Vite, Next.js, Astro, Nuxt, SvelteKit, Remix, Angular, CRA, Expo).",
    "Per-profile 'Has GUI preview' flag opens the panel automatically for a profile.",
    "Inline hint offers to open the preview when a URL is detected in any terminal.",
    "Allow-list in Settings — localhost is always allowed; add glob patterns like *.ngrok.io for tunnels."
  ]
}
```

Confirm actual version target via `package.json` before locking in the number.

- [ ] **Step 4: Commit + M2 tag**

```bash
git add src/changelog.json
git commit -m "docs(changelog): 1.28.0 preview panel"
git commit --allow-empty -m "chore(preview): M2 shipped — url bar + auto-detect + profile flag"
```

---

# MILESTONE 3 — Polish (device frames, resize, back/forward, pop-out)

Deferred until M1 + M2 are merged and verified. When ready, invoke `superpowers:writing-plans` again with the same spec (`docs/superpowers/specs/2026-07-23-preview-panel-design.md`) to generate M3 task-level detail. M3 scope from the spec:

- Drag-resize handle on the left edge of `PreviewPanel` (persist `panelWidthPx`).
- Device mode toggle (desktop / tablet 768px / mobile 375px) — pure CSS wrapping.
- Back/forward navigation using `history` + `historyIndex` in the store; capture iframe `location.href` on load events (guarded — cross-origin will throw; that's fine, we track only what we set).
- Dev-server network-status pill (probe iframe URL with a `HEAD` fetch from the parent window, show green/red dot).
- Pop-out via `WebviewWindow` — reuse the detached-window infra; label prefix `preview-*`; capability entry.

---

## Self-review — spec coverage

Cross-checking the spec against the plan:

- **Section 1 (Overview / dock architecture)** → Task 5, Task 6. ✓
- **Section 2 (Architecture / data flow)** → Task 6 (listener wiring), Task 4 (store), Task 14 (cleanup). ✓
- **Section 3 (New files)** → Tasks 1-5, 9, 13, 15, 16 cover all 11 new files listed in the spec. ✓
- **Section 3 (Modified files)** → Tasks 6, 7, 10, 11, 12, 14, 15. `changelog.json` in Task 17. ✓
- **Section 4 (Preview state)** → Task 4. ✓
- **Section 5 (Detection)** → Task 2 (URL regex + ANSI strip), Task 3 (framework), Task 15 (package.json read). ✓
- **Section 6 (Trigger rules)** → Task 14 (auto-open on profile flag), Task 13 (inline hint), Task 7 (manual toggle + shortcut). ✓
- **Section 7 (Per-tab behavior)** → Task 5 (default single iframe), Task 16 (keep-alive toggle in settings). `visibility: hidden` keep-alive rendering itself lands in M3 or is added as a small follow-up if we want to close M2 with parity.
- **Section 8 (Security)** → Task 1 (allow-list), Task 9 (URL bar validation), Task 5 (blocked-state render). ✓
- **Section 9 (Stages)** → Stage 1 = M1 (Tasks 1-8), Stage 2 = Task 9, Stage 3 = Tasks 10-16, Stages 4-7 = M3.
- **Section 10 (Verification)** → Task 8 (M1), Task 17 (M2). ✓

**Gap found:** the spec calls for `keepAliveAcrossTabs` to actually render multiple iframes with `visibility: hidden`, but Task 5 only implements the single-iframe path. This is fine for M1 (the toggle is off by default), but M2 should extend `PreviewPanel` to honour `keepAliveAcrossTabs`. Adding a small M2 sub-step:

## Task 16.5: Honour keep-alive toggle (extends Task 5)

**Files:**
- Modify: `src/components/PreviewPanel.tsx`

- [ ] **Step 1: Adjust PreviewPanel render logic**

When `keepAliveAcrossTabs` is true, iterate over all `perTerminal` entries with a non-null resolved URL and render an iframe per entry. Only the entry whose id matches `activeTerminalId` is visible; all others are `visibility: hidden; pointer-events: none;`.

- [ ] **Step 2: Type check + build + test**

Run: `npx tsc --noEmit && npx vite build && npx vitest run`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/PreviewPanel.tsx
git commit -m "feat(preview): honour keepAliveAcrossTabs (multi-iframe hidden mount)"
```

---

## Notes for the implementing engineer

- Every task is intended to be executable by a fresh subagent given only the spec + this plan + the current codebase. Don't infer requirements not written down.
- Where a step says "check the existing pattern in file X" — do that read before editing. The paste-as-file plan (already merged) is a good reference for how M2's `terminalStore` seeding maps onto the existing store shape.
- The keyboard shortcut choice is the most likely conflict. If `Ctrl+Shift+V` collides, the fallbacks are `Ctrl+Shift+G`, `Ctrl+Alt+P`. Record the final choice in the commit message.
- Don't add polish features from M3 to M1 or M2 tasks. Ship the milestone, then invoke `writing-plans` for M3.
