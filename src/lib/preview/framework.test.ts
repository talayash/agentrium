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
