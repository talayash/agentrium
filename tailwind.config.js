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
        // Borders / seams - translucent separation, not opaque lines. The
        // legacy `border` alias now points at the seam hairline: the old
        // opaque --ij-divider line is retired everywhere at once.
        'border': 'var(--seam)',
        'border-light': 'var(--seam)',
        'border-focus': 'var(--border-focus)',
        'seam': 'var(--seam)',
        'seam-strong': 'var(--seam-strong)',
        // Theme-aware interactive fills (see index.css). Use bg-fill-hover etc.
        'fill-hover': 'var(--fill-hover)',
        'fill-active': 'var(--fill-active)',
        'fill-sel': 'var(--fill-sel)',
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
        // Apple system font first (real SF Pro on macOS / installed Windows),
        // Inter as the SF-alike fallback everywhere else. Skill §15: prefer
        // the platform system font - it ships optical sizing + tracking tables.
        sans: [
          '-apple-system', 'BlinkMacSystemFont',
          'SF Pro Display', 'SF Pro Text', 'SF Pro',
          'Inter', 'system-ui', 'sans-serif',
        ],
        mono: ['SF Mono', 'JetBrains Mono', 'Fira Code', 'monospace'],
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
        // elevation-3/4 read the theme-aware float tokens (light overrides in
        // applyThemeMode) so shadows soften over a light canvas.
        'elevation-2': 'var(--shadow-float-sm)',
        'elevation-3': 'var(--shadow-float-md)',
        'elevation-4': 'var(--shadow-float-lg)',
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
