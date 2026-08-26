# Add a new React component

Create a new React component named `$ARGUMENTS` in `src/components/`. If no name is provided, ask the user.

## Requirements

Follow existing project patterns:

1. **TypeScript** - Define a props interface if the component accepts props
2. **Styling** - Use Tailwind CSS classes with the project's dark glassmorphic theme:
   - Backgrounds: `bg-gray-800/80`, `bg-gray-900/90` with `backdrop-blur`
   - Borders: `border border-gray-700/50`, `rounded-lg`
   - Text: `text-gray-100`, `text-gray-400` for secondary
   - Hover states: `hover:bg-gray-700/50`
3. **Animations** - Use Framer Motion (`motion.div`, `AnimatePresence`) for enter/exit transitions where appropriate
4. **State** - Use Zustand stores:
   - `appStore` for UI state (modals, sidebar, settings)
   - `terminalStore` for terminal instance state
5. **IPC** - If the component needs backend data, use `invoke` from `@tauri-apps/api/core`
6. **Events** - If listening for Tauri events, use `listen` from `@tauri-apps/api/event` and clean up in useEffect return

## After creation

- Add the component to the appropriate parent (`App.tsx` or another component)
- Wire up any needed state or event handling
