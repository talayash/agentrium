import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

// See ToastContainer.test.tsx for why the animation layer is a passthrough.
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

vi.mock('./ui/Tooltip', () => ({
  Tooltip: ({ children }: { children: unknown }) => children,
}));

import { UpdatePill } from './UpdatePill';
import { useUpdaterStore } from '../store/updaterStore';

const actions = {
  checkForUpdates: vi.fn(async () => ({ available: false })),
  downloadAndInstall: vi.fn(async () => true),
  restart: vi.fn(async () => undefined),
  clearDeferrals: vi.fn(),
};

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockClear();
  act(() => {
    useUpdaterStore.setState({
      status: 'available',
      updateInfo: { version: '2.4.0', date: '', body: '' },
      error: null,
      bannerDismissedVersion: '2.4.0',
      bannerSnoozedUntil: Date.now() + 60_000,
      skippedVersion: '2.4.0',
      ...actions,
    } as never);
  });
});

afterEach(cleanup);

describe('UpdatePill', () => {
  it('starts the download when the user asks for the update directly', () => {
    render(<UpdatePill />);
    fireEvent.click(screen.getByRole('button'));
    expect(actions.downloadAndInstall).toHaveBeenCalledTimes(1);
  });

  it('overrides every earlier "not now", including a skipped version', () => {
    render(<UpdatePill />);

    fireEvent.click(screen.getByRole('button'));

    // Without this the update sheet stays hidden and the user who just asked
    // for the update watches nothing happen.
    expect(actions.clearDeferrals).toHaveBeenCalledTimes(1);
  });
});
