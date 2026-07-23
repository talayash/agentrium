# Preview Panel — Base44/Lovable/Dyad-style live web preview

**Date:** 2026-07-23
**Goal:** Add a right-docked, resizable live-preview panel for terminals running web dev
servers. Auto-detects the dev-server URL from stdout and from `package.json`, honours a
per-profile "has GUI" flag, and can be toggled from a `ToolStripe` icon or keyboard shortcut.

## Overview

A ClaudeTerminal tab already IS the "prompting" pane (Claude Code lives in the terminal),
so we only need to add the preview surface. The panel slots in alongside the existing
right-side dockable panels (`FileChangesPanel`, `OrchestrationPanel`, `HintsPanel`) and is
wider + resizable, defaulting to ~50% of the main content area.

## Architecture

Pure frontend, no backend/IPC changes required (aside from an optional additive
`ConfigProfile` field, see Section 3). The Rust reader thread already emits
`terminal-output` events; a passive frontend detector subscribes to the same stream that
`App.tsx:415` already listens on, so removing the detector would not affect terminal I/O.

```
Rust: TerminalManager.reader_thread ──"terminal-output"──▶ frontend listener
                                                             │
   existing: handleTerminalOutput(id, bytes) ──▶ xterm.js    │
   NEW:      previewDetector.consume(id, bytes) ──▶ previewStore.setDetectedUrl
                                                             │
                                                             ▼
                                                     <PreviewPanel/>
```

**Invariants:**
- Detection is passive — no critical path.
- State is per-terminal; the panel is a singleton (one live iframe at a time by default).
- No new IPC. `fs:read-text-file` for `package.json`, existing `open_external_url` for the
  external browser button, existing `WebviewWindow` for pop-out.

## New files

| Path | Purpose |
|---|---|
| `src/components/PreviewPanel.tsx` | Docked panel: header, iframe surface, drag-resize handle |
| `src/components/PreviewToolbar.tsx` | URL bar, reload, external open, device toggle, back/forward, pop-out, close |
| `src/components/PreviewInlineHint.tsx` | Small "Detected `http://…` — Open preview" toast strip for ad-hoc terminals |
| `src/components/settings/PreviewSettingsSection.tsx` | Allow-list editor, default device mode, `keepAliveAcrossTabs` |
| `src/store/previewStore.ts` | Zustand slice (see Section 3) |
| `src/lib/preview/detector.ts` | Pure `detectUrl(text): string \| null` — regex + priority |
| `src/lib/preview/framework.ts` | Pure `detectFramework(packageJson): FrameworkHint` |
| `src/lib/preview/allowlist.ts` | Pure `isUrlAllowed(url, allowList): boolean` |
| `src/lib/preview/__tests__/detector.test.ts` | Vitest against known dev-server output fixtures |
| `src/lib/preview/__tests__/framework.test.ts` | Vitest — `package.json` → framework mapping |
| `src/lib/preview/__tests__/allowlist.test.ts` | Vitest — scheme, hostname, glob match |

## Modified files

| Path | Change |
|---|---|
| `src/App.tsx` | Register detector in the `terminal-output` listener; render `<PreviewPanel/>` in the right-panel dock area |
| `src/components/ToolStripe.tsx` | Add a preview toggle icon (right side, next to changes/hints/orchestration) |
| `src/components/ProfileModal.tsx` | Add a "Has GUI preview" checkbox + optional URL override input |
| `src/hooks/useKeyboardShortcuts.ts` | Bind a preview-toggle shortcut (default `Ctrl+Shift+V`; verify no conflict before landing) |
| `src/store/terminalStore.ts` | On `createTerminal`, seed `previewStore` with framework hint + profile `preview` block. On `closeTerminal`, call `previewStore.removeTerminal(id)` |
| `src-tauri/src/config.rs` | Add `preview: Option<PreviewProfile>` to `ConfigProfile` (backwards compatible via `#[serde(default)]`) |
| `src-tauri/src/database.rs` | Migration: add nullable `preview_json TEXT` column to `profiles`. Existing rows read as `NULL` → `preview: None` |
| `src-tauri/capabilities/default.json` | Ensure `fs:read-text-file` allows reading `package.json` under a terminal's `working_directory`; ensure `shell:open` is scoped for external browser opens |

## Preview state

```ts
// src/store/previewStore.ts
type DeviceName = 'desktop' | 'tablet' | 'mobile';
interface DeviceMode { name: DeviceName; width: number; height?: number }

type FrameworkHint =
  | 'nextjs' | 'vite' | 'astro' | 'nuxt' | 'sveltekit' | 'remix'
  | 'angular' | 'cra' | 'expo' | 'unknown';

interface PreviewState {
  isOpen: boolean;              // panel visible when this terminal is active
  detectedUrl: string | null;   // last URL scraped from stdout
  userOverride: string | null;  // URL manually entered — wins over detectedUrl
  frameworkHint: FrameworkHint;
  deviceMode: DeviceMode;
  history: string[];
  historyIndex: number;
  lastError: string | null;
  reloadCounter: number;        // bump to force iframe remount on Reload
}

interface PreviewStoreState {
  perTerminal: Map<string, PreviewState>;
  globalOpen: boolean;          // master toggle
  allowList: string[];          // e.g. ["*.ngrok.io", "*.trycloudflare.com"]
  keepAliveAcrossTabs: boolean; // opt-in "keep all iframes mounted"
  panelWidthPx: number;         // resizable, persisted

  seedTerminal(id: string, initial: Partial<PreviewState>): void;
  setDetectedUrl(id: string, url: string): void;
  setUserOverride(id: string, url: string): void;
  removeTerminal(id: string): void;
  toggleGlobal(): void;
  setDeviceMode(id: string, mode: DeviceMode): void;
  reload(id: string): void;
  goBack(id: string): void;
  goForward(id: string): void;
  addToAllowList(pattern: string): void;
  setPanelWidth(px: number): void;
}
```

**Persistence:** `allowList`, `keepAliveAcrossTabs`, `panelWidthPx`, `globalOpen` are
persisted via `zustand/middleware/persist` (matches existing `appStore` pattern).
`perTerminal` is **not** persisted (ephemeral like `terminalStore`).

**Rust `PreviewProfile`:**

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct PreviewProfile {
    pub enabled: bool,             // "This profile has a GUI"
    pub url_override: Option<String>,
    pub framework_hint: Option<String>,
}
// In ConfigProfile:
#[serde(default)]
pub preview: Option<PreviewProfile>,
```

## Detection

**URL regex (frontend):**

```ts
const URL_PATTERN = /(?:Local[:\s]+|➜\s+Local:\s+|Listening on\s+|Server ready at\s+|ready\s+-\s+started server on\s+)?(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{1,5}))/gi;
```

Priority: most recent match in the chunk wins. Input is stripped of ANSI escape codes
before matching (dev-server output usually contains `\x1b[...m` colour codes):

```ts
const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;
const stripAnsi = (s: string) => s.replace(ANSI_PATTERN, '');
```

**Fixtures** (`detector.test.ts` must exercise all of these):

- Vite: `➜  Local:   http://localhost:5173/`
- Next.js 13-14: `- Local:        http://localhost:3000`
- Next.js 15+: `▲ Next.js 15.0.0\n- Local: http://localhost:3000`
- CRA: `Local:            http://localhost:3000`
- Astro: `┃ Local    http://localhost:4321/`
- Nuxt: `➜ Local:    http://localhost:3000/`
- SvelteKit: `➜  Local:   http://localhost:5173/`
- Angular: `Angular Live Development Server is listening on localhost:4200`
- Remix: `[remix-serve] http://localhost:3000`
- Expo web: `Web is waiting on http://localhost:19006`

**Framework hint (`framework.ts`):** priority `scripts.dev` > `dependencies` >
`devDependencies`. Mapping:

- `next` → `'nextjs'` (default port 3000)
- `vite` → `'vite'` (default port 5173)
- `@angular/core` → `'angular'` (default port 4200)
- `astro` → `'astro'` (default port 4321)
- `nuxt` → `'nuxt'` (default port 3000)
- `@sveltejs/kit` → `'sveltekit'` (default port 5173)
- `@remix-run/dev` → `'remix'` (default port 3000)
- `react-scripts` → `'cra'` (default port 3000)
- `expo` → `'expo'` (default port 8081, web 19006)
- Otherwise → `'unknown'`

Framework hint drives only the pre-detection "waiting for X dev server…" copy; the
scraped URL always overrides the guessed default port once seen.

## Trigger rules (when the panel appears)

- **Profile flagged `preview.enabled = true`:** panel opens automatically the first time
  the terminal produces any output (immediately if `userOverride` is set).
- **Any terminal, ad-hoc:** on first detection of a localhost URL, `PreviewInlineHint`
  slides in for ~6 s ("Detected `http://localhost:5173` — Open preview"). Click opens the
  panel and stops the hint from re-showing for that terminal.
- **Manual:** the `ToolStripe` right-side icon toggles `globalOpen`. Shortcut
  `Ctrl+Shift+V` if free, else fall back in order to `Ctrl+Shift+G`, `Ctrl+Alt+P`;
  final chosen binding is recorded in the implementation plan, not the spec.

## Per-tab behavior

Default: single iframe, active-tab-driven. When the active terminal changes, the current
iframe unmounts and the new terminal's iframe mounts. If `keepAliveAcrossTabs` is on,
all iframes stay mounted with `visibility: hidden` for inactive tabs (opt-in from
Settings — costs one live iframe + dev-server WebSocket per open terminal).

## Security

**URL allow-list (`allowlist.ts`):**

- Always allow `http://localhost:*`, `http://127.0.0.1:*`, `http://0.0.0.0:*`, `https://`
  variants of the same.
- Match user-defined glob patterns (e.g. `*.ngrok.io`) using a small hand-rolled matcher
  (no `minimatch` dependency): `*` matches one hostname label, `.` is literal, everything
  else is literal. Reject `ngrok.io.evil.com` (dot boundary check).
- Everything else → rejected. Panel shows "URL not allowed. Add hostname to Preview
  allow-list in Settings." with a one-click "Open Settings" button.

**Iframe attributes:** no `sandbox`, no `referrerpolicy` override. Same trust level as
`npm run dev` in the terminal.

**URL bar:** free-form input, re-validated via `isUrlAllowed` on every change. Invalid
URLs surface an inline error and don't touch the iframe `src`.

**Pop-out (Q6 D):** reuses `WebviewWindow`. The new detached window loads the preview URL
directly (not the React bundle). Capability: extend `webviewWindow:allow-create` with a
label prefix `preview-*`.

## Implementation stages (Q6 D — staged for early ship-ability)

Each stage is testable + shippable:

1. iframe surface + reload + external-open (minimum viable preview)
2. URL bar + allow-list validation (Q7-B satisfied)
3. Framework detection + inline hint + auto-open on profile flag (Q5-C satisfied)
4. Drag-resize handle + Settings integration
5. Device frame toggle (desktop/tablet/mobile CSS wrappers, no emulation)
6. Back/forward navigation + dev-server network-status pill
7. Pop-out into detached `WebviewWindow`

## Non-goals

- Screen capture / native GUI preview (Q1 — deferred).
- Multiple simultaneous iframes without `keepAliveAcrossTabs` (Q4 — deferred).
- Full mobile emulator (real touch events, viewport meta emulation) — device frames are
  CSS-only.
- Editing the previewed page from within the panel (this is a preview, not a canvas).
- Port scanning (Q3 D — rejected).

## Verification

- Unit tests: `detectUrl` (10 fixtures), `detectFramework` (per-package fixture), 
  `isUrlAllowed` (localhost variants, glob match, hostname boundary), `previewStore` 
  (lifecycle, keep-alive toggle, override priority).
- Component tests: `PreviewPanel` renders iframe only for a valid allowed URL; renders 
  waiting/blocked/error states appropriately.
- `npx tsc --noEmit`, `vite build`, existing vitest suite green.
- Manual: launch `npm run tauri dev` in a Vite project via ClaudeTerminal, verify (a) 
  auto-open on profile flag, (b) URL detected within 5s of dev-server ready, (c) 
  `ToolStripe` toggle works, (d) tab switch swaps iframe, (e) `closeTerminal` releases 
  state (spot-check via React DevTools).
- Security review: run the security-review skill against the diff before merging.
