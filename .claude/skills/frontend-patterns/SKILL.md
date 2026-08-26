---
name: frontend-patterns
description: React/TypeScript/xterm.js patterns for ClaudeTerminal frontend
---

# Frontend Patterns for ClaudeTerminal

## xterm.js Lifecycle
- Create terminal instance in useEffect, dispose on unmount
- Dispose all addons (fit, search, weblinks) before terminal
- Never hold references to disposed terminals

## Event Listeners
- `listen()` returns unlisten function - call it in useEffect cleanup
- Register listeners in App.tsx for global events (terminal-output, terminal-finished)

## Zustand
- `terminalStore` - NOT persisted (terminals are ephemeral)
- `appStore` - persisted to localStorage (UI state)
- Use selectors to avoid unnecessary re-renders
- Avoid stale closures - use `getState()` in callbacks

## IPC
- Always wrap `invoke()` in try/catch
- Handle both success and error cases
- Show loading states for slow operations

## Styling
- Dark glassmorphic theme: `bg-gray-800/80`, `border-gray-700/50`, `backdrop-blur`
- Use Tailwind classes - no hardcoded colors
- Framer Motion for animations
