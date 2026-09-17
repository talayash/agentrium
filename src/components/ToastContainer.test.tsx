import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

// Framer drives enter/exit off its own requestAnimationFrame loop against the
// real `performance.now()`, which jsdom's fake timers do not advance - an
// exiting card would stay mounted forever and every "is it gone?" assertion
// would pass vacuously. Swapping the animation layer for a passthrough makes
// what is on screen a direct function of store state, which is the behaviour
// these tests are actually about. The motion itself is covered by
// motionTokens.test.ts.
vi.mock('framer-motion', async () => {
  const { createElement, forwardRef } = await import('react');
  const MOTION_ONLY_PROPS = [
    'initial', 'animate', 'exit', 'layout', 'layoutId', 'transition',
    'variants', 'whileHover', 'whileTap', 'whileFocus', 'whileInView', 'drag',
  ];
  const strip = (props: Record<string, unknown>): Record<string, unknown> => {
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (!MOTION_ONLY_PROPS.includes(key)) rest[key] = value;
    }
    return rest;
  };
  return {
    AnimatePresence: ({ children }: { children?: unknown }) => children,
    motion: new Proxy({} as Record<string, unknown>, {
      get: (_target, tag: string) =>
        forwardRef<unknown, Record<string, unknown>>((props, ref) =>
          createElement(tag, { ...strip(props), ref }),
        ),
    }),
  };
});

import { ToastContainer } from './ToastContainer';
import { useToastStore } from '../store/toastStore';
import type { Toast } from '../store/toastStore';

type NewToast = Omit<Toast, 'id' | 'duration' | 'createdAt'> & { duration?: number };

function addToast(input: NewToast): string {
  let id = '';
  act(() => {
    id = useToastStore.getState().addToast(input);
  });
  return id;
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  act(() => useToastStore.getState().clearAll());
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ToastContainer', () => {
  it('shows the title, the message and how long ago it arrived', () => {
    addToast({ type: 'info', title: 'Session restored', message: '4 terminals reattached', duration: 0 });

    render(<ToastContainer />);

    expect(screen.getByText('Session restored')).toBeTruthy();
    expect(screen.getByText('4 terminals reattached')).toBeTruthy();
    expect(screen.getByText('now')).toBeTruthy();
  });

  it('ages the timestamp while the notification stays on screen', () => {
    addToast({ type: 'info', title: 'Session restored', duration: 0 });
    render(<ToastContainer />);
    expect(screen.getByText('now')).toBeTruthy();

    advance(5 * 60_000);

    expect(screen.getByText('5m')).toBeTruthy();
  });

  it('announces errors assertively and everything else politely', () => {
    addToast({ type: 'error', title: 'Push rejected', duration: 0 });
    addToast({ type: 'success', title: 'Pushed', duration: 0 });

    render(<ToastContainer />);

    expect(screen.getByRole('alert').textContent).toContain('Push rejected');
    expect(screen.getByRole('status').textContent).toContain('Pushed');
  });

  it('keeps a notification on screen while the pointer is over it', () => {
    addToast({ type: 'info', title: 'Hovered', duration: 1000 });
    render(<ToastContainer />);

    fireEvent.mouseEnter(screen.getByRole('status'));
    advance(5000);
    expect(screen.queryByText('Hovered')).toBeTruthy();

    fireEvent.mouseLeave(screen.getByRole('status'));
    advance(1000);
    expect(screen.queryByText('Hovered')).toBeNull();
  });

  it('runs an action and then dismisses the notification', () => {
    const onClick = vi.fn();
    addToast({
      type: 'error',
      title: 'Push rejected',
      actions: [{ label: 'Pull and Retry', onClick }],
    });
    render(<ToastContainer />);

    fireEvent.click(screen.getByRole('button', { name: 'Pull and Retry' }));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Push rejected')).toBeNull();
  });

  it('dismisses a single notification from its close button', () => {
    addToast({ type: 'info', title: 'Session restored', duration: 0 });
    render(<ToastContainer />);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));

    expect(screen.queryByText('Session restored')).toBeNull();
  });

  it('collapses to the newest notification once more than three are waiting', () => {
    for (const title of ['First', 'Second', 'Third', 'Fourth']) {
      addToast({ type: 'info', title, duration: 0 });
    }

    render(<ToastContainer />);

    expect(screen.getByText('Fourth')).toBeTruthy();
    expect(screen.queryByText('First')).toBeNull();
    expect(screen.getByRole('button', { name: '3 more notifications' })).toBeTruthy();
  });

  it('shows all three when exactly three are waiting', () => {
    for (const title of ['First', 'Second', 'Third']) {
      addToast({ type: 'info', title, duration: 0 });
    }

    render(<ToastContainer />);

    expect(screen.getByText('First')).toBeTruthy();
    expect(screen.getByText('Third')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /more notifications/ })).toBeNull();
  });

  it('fans the stack out on click and offers to clear it', () => {
    for (const title of ['First', 'Second', 'Third', 'Fourth']) {
      addToast({ type: 'info', title, duration: 0 });
    }
    render(<ToastContainer />);

    fireEvent.click(screen.getByRole('button', { name: '3 more notifications' }));

    expect(screen.getByText('First')).toBeTruthy();
    expect(screen.getByText('Fourth')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Clear All' }));

    expect(screen.queryByText('Fourth')).toBeNull();
  });

  it('renders nothing at all when there are no notifications', () => {
    const { container } = render(<ToastContainer />);
    expect(container.textContent).toBe('');
  });

  it('anchors to the bottom-right corner, never the top', () => {
    addToast({ type: 'info', title: 'Terminal Finished', duration: 0 });
    render(<ToastContainer />);

    const region = screen.getByTestId('notification-region');
    expect(region.className).toMatch(/\bbottom-/);
    expect(region.className).not.toMatch(/\btop-/);
  });

  it('stacks the newest notification nearest the corner', () => {
    for (const title of ['First', 'Second', 'Third']) {
      addToast({ type: 'info', title, duration: 0 });
    }
    render(<ToastContainer />);

    // Bottom-anchored, so the newest sits LAST in document order.
    const titles = screen
      .getAllByRole('status')
      .map((card) => card.querySelector('p')?.textContent);
    expect(titles).toEqual(['First', 'Second', 'Third']);
  });
});
