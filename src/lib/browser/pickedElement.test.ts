import { describe, expect, it } from 'vitest';
import { formatPickedElement, type PickedElement } from './pickedElement';

const el: PickedElement = {
  url: 'https://example.com/login',
  title: 'Sign in',
  selector: '#login > button:nth-of-type(2)',
  tag: 'button',
  text: 'Sign in with GitHub',
  html: '<button class="btn">Sign in with GitHub</button>',
};

describe('formatPickedElement', () => {
  it('formats a reviewable markdown block', () => {
    const out = formatPickedElement(el);
    expect(out.startsWith('## Page element')).toBe(true);
    expect(out).toContain('URL: https://example.com/login');
    expect(out).toContain('Selector: `#login > button:nth-of-type(2)`');
    expect(out).toContain('Sign in with GitHub');
    expect(out).toContain('```html\n<button class="btn">Sign in with GitHub</button>\n```');
  });

  it('leaves out empty fields without placeholders', () => {
    const out = formatPickedElement({ ...el, title: '', text: '' });
    expect(out).not.toMatch(/undefined|null|\$\{/);
    expect(out).not.toContain('Text:');
    expect(out).not.toContain('Title:');
    expect(out).not.toMatch(/\n\n\n/);
  });

  it('keeps page backticks from closing the fences', () => {
    const out = formatPickedElement({ ...el, selector: '#a\\`b', html: '<pre>```</pre>' });
    expect(out).toContain('Selector: ``#a\\`b``');
    expect(out).toContain('````html\n<pre>```</pre>\n````');
  });
});
