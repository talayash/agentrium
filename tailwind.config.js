/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // Legacy aliases (map to the surface ramp)
        'bg-primary': 'var(--elevation-0)',
        'bg-secondary': 'var(--elevation-1)',
        'bg-elevated': 'var(--elevation-2)',
        'bg-surface': 'var(--elevation-3)',
        // Surface ramp - Apple dark/light neutrals (values live in index.css /
        // accentTheme.applyThemeMode). Names kept from the elevation system so
        // all consumers reskin in place.
        'elevation-0': 'var(--elevation-0)', // Canvas / app background
        'elevation-1': 'var(--elevation-1)', // Chrome: sidebar, tabs, status bar
        'elevation-2': 'var(--elevation-2)', // Cards, panels, inputs
        'elevation-3': 'var(--elevation-3)', // Hover / selected fills
        'elevation-4': 'var(--elevation-4)', // Menus, popovers, modal base
        // Accent - follows the user's accent via CSS vars (applyAccentColor).
        // Defaults are Apple system blue, set in index.css :root.
        'accent-primary': 'var(--accent-primary)',
        'accent-secondary': 'var(--accent-secondary)',
        // Borders / seams - translucent separation, not opaque lines
        'border': 'var(--ij-divider)',
        'border-light': 'var(--seam)',
        'border-focus': 'var(--border-focus)',
        'seam': 'var(--seam)',
        'seam-strong': 'var(--seam-strong)',
        // Text tokens are theme-aware: dark channels live in index.css :root,
        // light channels are swapped in by applyThemeMode(). Channel-triplet
        // form keeps Tailwind's /opacity modifiers working.
        'text-primary': 'rgb(var(--text-primary) / <alpha-value>)',
        'text-secondary': 'rgb(var(--text-secondary) / <alpha-value>)',
        'text-tertiary': 'rgb(var(--text-tertiary) / <alpha-value>)',
        // Semantic - Apple system palette (theme-aware via CSS vars; light
        // overrides are applied by accentTheme.applyThemeMode()).
        'success': 'var(--success)',
        'warning': 'var(--warning)',
        'error': 'var(--error)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      letterSpacing: {
        // Optical tracking bands (see index.css) - use instead of raw values.
        display: 'var(--track-display)',
        title: 'var(--track-title)',
        body: 'var(--track-body)',
        caption: 'var(--track-caption)',
      },
      boxShadow: {
        // Accent-aware - derived vars are (re)set by applyAccentColor() so the
        // glow follows the user's chosen accent instead of hardcoded blue.
        'glow-sm': '0 0 8px var(--accent-glow-sm)',
        'glow-md': '0 0 16px var(--accent-glow-md)',
        // Layered ambient+key shadows - surfaces float, they don't outline.
        'elevation-2': '0 1px 3px rgba(0, 0, 0, 0.28), 0 4px 12px rgba(0, 0, 0, 0.20)',
        'elevation-3': '0 2px 8px rgba(0, 0, 0, 0.32), 0 12px 32px rgba(0, 0, 0, 0.28)',
        'elevation-4': '0 6px 20px rgba(0, 0, 0, 0.38), 0 28px 72px rgba(0, 0, 0, 0.42)',
      },
      borderRadius: {
        // Apple's softer, continuous-feel corners (tokens in index.css)
        'sm': 'var(--radius-sm)',
        'md': 'var(--radius-md)',
        'lg': 'var(--radius-lg)',
        'xl': 'var(--radius-xl)',
      },
    },
  },
  plugins: [],
}
