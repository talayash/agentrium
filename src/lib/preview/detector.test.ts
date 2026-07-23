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
