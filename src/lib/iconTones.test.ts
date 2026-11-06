import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Icon tones live in index.css. Every family must resolve to a hue in both
// themes, or a toned icon silently falls back to `currentColor` in one theme.
const css = readFileSync(resolve(__dirname, '../index.css'), 'utf8');
const TONES = ['view', 'git', 'file', 'run', 'idea', 'web', 'user', 'danger'];

function block(selector: string): string {
  const i = css.indexOf(`${selector} {\r\n  --icon-`) >= 0
    ? css.indexOf(`${selector} {\r\n  --icon-`)
    : css.indexOf(`${selector} {\n  --icon-`);
  expect(i, `${selector} icon block`).toBeGreaterThanOrEqual(0);
  return css.slice(i, css.indexOf('}', i));
}

describe('icon tones', () => {
  it.each(TONES)('maps data-tone="%s" to its token', (tone) => {
    expect(css).toContain(`[data-tone="${tone}"] { --tone: var(--icon-${tone}); }`);
  });

  it('defines every tone in the dark block', () => {
    const dark = block(':root');
    for (const t of TONES) expect(dark).toContain(`--icon-${t}:`);
  });

  it('overrides every fixed hue in the light block (view follows the accent)', () => {
    const light = block(':root[data-theme="light"]');
    for (const t of TONES.filter((t) => t !== 'view')) expect(light).toContain(`--icon-${t}:`);
  });

  it('builds tiles with color-mix, never opacity utilities', () => {
    const start = css.indexOf('.tone-btn[data-tone] {');
    expect(css.slice(start)).toContain('color-mix(in srgb, var(--tone)');
  });
});
