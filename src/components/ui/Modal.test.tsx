import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { Modal } from './Modal';

describe('Modal stacking', () => {
  afterEach(cleanup);

  it('Escape closes only the topmost of two stacked modals', () => {
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    const { rerender } = render(
      <>
        <Modal onClose={closeOuter}><button>outer</button></Modal>
        <Modal onClose={closeInner}><button>inner</button></Modal>
      </>,
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(closeInner).toHaveBeenCalledTimes(1);
    expect(closeOuter).not.toHaveBeenCalled();

    // Once the inner one is gone, the outer one owns Escape again.
    rerender(<Modal onClose={closeOuter}><button>outer</button></Modal>);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(closeOuter).toHaveBeenCalledTimes(1);
    expect(closeInner).toHaveBeenCalledTimes(1);
  });

  it('a lower modal does not steal Tab focus from the top one', () => {
    const { getByText } = render(
      <>
        <Modal onClose={() => {}}><button>outer</button></Modal>
        <Modal onClose={() => {}}><button>inner-a</button><button>inner-b</button></Modal>
      </>,
    );
    // Watch the lower dialog's button: with both traps active, the lower
    // one would yank focus to it (and the top one would snatch it back).
    const outerFocused = vi.fn();
    getByText('outer').addEventListener('focus', outerFocused);
    getByText('inner-b').focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(outerFocused).not.toHaveBeenCalled();
    // jsdom has no layout (offsetParent is null), so the trap lands on the
    // top panel itself; what matters is that focus stays in the top dialog.
    expect(getByText('inner-a').closest('[role="dialog"]')!.contains(document.activeElement)).toBe(true);
  });
});
