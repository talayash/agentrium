// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isVisibilityHidden } from './dragDrop';

function mount(el: HTMLElement): HTMLElement {
  document.body.appendChild(el);
  return el;
}

describe('isVisibilityHidden', () => {
  it('returns false for a plain visible element', () => {
    const el = mount(document.createElement('div'));
    expect(isVisibilityHidden(el)).toBe(false);
    el.remove();
  });

  it('returns true when the element itself is visibility: hidden', () => {
    const el = mount(document.createElement('div'));
    el.style.visibility = 'hidden';
    expect(isVisibilityHidden(el)).toBe(true);
    el.remove();
  });

  it('returns true when an ancestor is visibility: hidden (inactive tab stack)', () => {
    // Mirrors TerminalTabs: every terminal stays mounted, stacked absolute
    // inset-0, and inactive ones get inline visibility: hidden on a wrapper.
    const wrapper = mount(document.createElement('div'));
    wrapper.style.visibility = 'hidden';
    const inner = document.createElement('div');
    const container = document.createElement('div');
    wrapper.appendChild(inner);
    inner.appendChild(container);
    expect(isVisibilityHidden(container)).toBe(true);
    wrapper.remove();
  });

  it('returns false when the visible sibling stack is checked', () => {
    const wrapper = mount(document.createElement('div'));
    wrapper.style.visibility = 'visible';
    const container = document.createElement('div');
    wrapper.appendChild(container);
    expect(isVisibilityHidden(container)).toBe(false);
    wrapper.remove();
  });
});
