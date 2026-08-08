/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // Legacy aliases (map to elevation system)
        'bg-primary': 'var(--elevation-0)',
        'bg-secondary': 'var(--elevation-1)',
        'bg-elevated': 'var(--elevation-2)',
        'bg-surface': 'var(--elevation-3)',
        // Elevation system — IntelliJ IDEA New UI (Dark)
        'elevation-0': 'var(--elevation-0)', // Main editor bg
        'elevation-1': 'var(--elevation-1)', // Tool windows, tabs, sidebar
        'elevation-2': 'var(--elevation-2)', // Cards, panels
        'elevation-3': 'var(--elevation-3)', // Hover / selected row
        'elevation-4': 'var(--elevation-4)', // Popups, dropdowns, modals
        // Accent — IntelliJ blue
        'accent-primary': '#3574F0',
        'accent-secondary': '#548AF7',
        // Borders
        'border': '#1E1F22',
        'border-light': '#393B40',
        'border-focus': 'rgba(53, 116, 240, 0.55)',
        // Text (IntelliJ New UI tokens)
        // Text tokens are theme-aware: dark channels live in index.css :root,
        // light channels are swapped in by applyThemeMode(). Channel-triplet
        // form keeps Tailwind's /opacity modifiers working. text-tertiary was
        // lifted to #8A8E97 (dark) for WCAG AA — the old #6F737A measured ~3.46:1
        // on elevation-0 / ~2.90:1 on elevation-1, below the 4.5:1 floor.
        'text-primary': 'rgb(var(--text-primary) / <alpha-value>)',
        'text-secondary': 'rgb(var(--text-secondary) / <alpha-value>)',
        'text-tertiary': 'rgb(var(--text-tertiary) / <alpha-value>)',
        // Semantic — IntelliJ palette (theme-aware via CSS vars; light overrides
        // are applied by accentTheme.applyThemeMode()).
        'success': 'var(--success)',
        'warning': 'var(--warning)',
        'error': 'var(--error)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      boxShadow: {
        'glow-sm': '0 0 8px rgba(53, 116, 240, 0.14)',
        'glow-md': '0 0 16px rgba(53, 116, 240, 0.22)',
        'elevation-2': '0 1px 2px rgba(0, 0, 0, 0.35)',
        'elevation-3': '0 4px 12px rgba(0, 0, 0, 0.45)',
        'elevation-4': '0 8px 28px rgba(0, 0, 0, 0.55)',
      },
      borderRadius: {
        // IntelliJ prefers slightly softer radii
        'md': '6px',
        'lg': '8px',
      },
    },
  },
  plugins: [],
}
