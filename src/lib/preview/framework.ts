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
