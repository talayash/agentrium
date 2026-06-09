# Auto-hiding terminal scrollbar — design

**Date:** 2026-06-09
**Status:** Approved

## Goal

Give each terminal a good-looking scrollbar on the right edge that appears on user
activity (mouse move / scroll) and fades out when idle. Applies to both regular and
grid mode. Behavior is configurable in Settings via a three-way mode.

## Background

xterm's `.xterm-viewport` is a real scrollable `<div>`. `index.css` already themes its
WebKit scrollbar (10px, muted grey thumb), but it is *always* visible. This feature makes
it smart: hidden until the user interacts, and only when there is content to scroll.

`TerminalGrid` renders `TerminalView` per cell, so all logic lives in `TerminalView` and
applies to both layouts automatically.

## Setting

New persisted store field on `appStore`:

- `terminalScrollbarMode: 'auto-hide' | 'always' | 'hidden'` (default `'auto-hide'`)
- Setter `setTerminalScrollbarMode`
- Added to `partialize`. No persist migration needed — an absent key falls back to the
  default for upgrading users.

UI: a `Segmented` control on `TerminalAppearancePage` under "Buffer & rendering":

> **Scrollbar** — `[ Auto-hide | Always | Hidden ]`

Registered via `registerSetting` so it is searchable.

## Rendering approach (Option A — native scrollbar + class toggle)

Keep the native WebKit scrollbar; do not build a custom overlay div. Control visibility
with a class on `.xterm-viewport`:

- Thumb is transparent by default.
- A `ct-sb-show` class on the viewport gives the thumb its color.
- The thumb transitions `background-color` (alpha) so it fades in/out. WebView2 is
  Chromium, so this animates. When reduce-motion is active, the transition is suppressed
  (instant show/hide).
- `hidden` mode collapses the scrollbar to `width: 0`.

Rationale: far less code than a position-synced overlay, and native scroll/drag behavior
is preserved.

## Auto-hide logic (`TerminalView`)

An effect keyed on `terminalScrollbarMode` grabs the `.xterm-viewport` element after the
terminal is open and wires behavior per mode:

- **`hidden`** → add `ct-sb-hidden`; no listeners.
- **`always`** → keep `ct-sb-show` on permanently (the empty-buffer check still applies via
  CSS — an unscrollable viewport has no thumb anyway).
- **`auto-hide`** → listen for `mousemove` on the container and `scroll` on the viewport.
  On either event, *if the buffer is actually scrollable*
  (`viewport.scrollHeight - viewport.clientHeight > 2`), add `ct-sb-show` and reset a
  ~1500 ms idle timer that removes it.

PTY output alone never reveals the scrollbar — only mouse move / scroll do, matching
"no input from client = hide". The "only when scrollable" guard means a fresh terminal
with nothing scrolled off-screen shows no track.

The mode is read reactively so changing it in Settings takes effect on open terminals
without recreating the xterm instance.

## Files touched

- `src/store/appStore.ts` — field, setter, default, `partialize` entry, exported mode type.
- `src/components/settings/categories/TerminalAppearancePage.tsx` — `Segmented` control +
  `registerSetting`.
- `src/components/TerminalView.tsx` — the auto-hide effect.
- `src/index.css` — rework `.xterm-viewport` scrollbar rules for the three states + fade.

No backend/Rust changes. No new dependencies.

## Testing / verification

- `npm run build` (tsc + vite) passes.
- Manual: auto-hide reveals on mouse move/scroll and fades after idle; stays hidden on PTY
  output alone; no track on an unscrollable buffer; `always` and `hidden` modes behave;
  works in grid mode; setting persists across restart.
