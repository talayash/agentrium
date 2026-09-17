import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

// See ToastContainer.test.tsx - framer's rAF loop does not advance under
// jsdom fake timers, so the animation layer is a passthrough here.
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

const invokeMock = vi.fn(async () => undefined);
const onFocusChangedMock = vi.fn(async () => () => {});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...(args as [])),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ onFocusChanged: onFocusChangedMock }),
}));

vi.mock('../lib/errorReporter', () => ({
  reportInvokeFailure: vi.fn(),
}));

import { AutoUpdater } from './AutoUpdater';
import { useUpdaterStore } from '../store/updaterStore';

const actions = {
  checkForUpdates: vi.fn(async () => ({ available: false })),
  downloadAndInstall: vi.fn(async () => true),
  restart: vi.fn(async () => undefined),
  dismissBanner: vi.fn(),
  snoozeBanner: vi.fn(),
  skipVersion: vi.fn(),
  markNotified: vi.fn(),
};

const UPDATE = { version: '2.4.0', date: '2026-09-15', body: 'Inline diff view' };

function setStore(patch: Record<string, unknown>): void {
  act(() => {
    useUpdaterStore.setState({
      status: 'idle',
      updateInfo: null,
      downloadProgress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      error: null,
      lastCheckAt: Date.now(),
      bannerDismissedVersion: null,
      bannerSnoozedUntil: null,
      notifiedVersion: '2.4.0',
      skippedVersion: null,
      ...actions,
      ...patch,
    } as never);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const fn of Object.values(actions)) fn.mockClear();
  invokeMock.mockClear();
  setStore({});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('AutoUpdater', () => {
  it('stays out of the way when there is no update', () => {
    setStore({ status: 'up-to-date' });
    render(<AutoUpdater />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  describe('an update is available', () => {
    beforeEach(() => setStore({ status: 'available', updateInfo: UPDATE }));

    it('names the version on offer and shows its release notes', () => {
      render(<AutoUpdater />);

      expect(screen.getByRole('dialog')).toBeTruthy();
      expect(screen.getByText('A new version is available')).toBeTruthy();
      expect(screen.getByText(/2\.4\.0/)).toBeTruthy();
      expect(screen.getByText(/Inline diff view/)).toBeTruthy();
    });

    it('offers exactly one default action and two ways out', () => {
      render(<AutoUpdater />);

      expect(screen.getByRole('button', { name: 'Update' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Later' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Skip This Version' })).toBeTruthy();
      // An alert has no close box - the buttons are the only way out.
      expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    });

    it('starts the download from the default action', () => {
      render(<AutoUpdater />);
      fireEvent.click(screen.getByRole('button', { name: 'Update' }));
      expect(actions.downloadAndInstall).toHaveBeenCalledTimes(1);
    });

    it('defers until next launch from Later', () => {
      render(<AutoUpdater />);
      fireEvent.click(screen.getByRole('button', { name: 'Later' }));
      expect(actions.dismissBanner).toHaveBeenCalledTimes(1);
    });

    it('snoozes for four hours when Later is Option-clicked', () => {
      render(<AutoUpdater />);
      fireEvent.click(screen.getByRole('button', { name: 'Later' }), { altKey: true });

      expect(actions.snoozeBanner).toHaveBeenCalledWith(4 * 60 * 60 * 1000);
      expect(actions.dismissBanner).not.toHaveBeenCalled();
    });

    it('retires the version for good from Skip This Version', () => {
      render(<AutoUpdater />);
      fireEvent.click(screen.getByRole('button', { name: 'Skip This Version' }));
      expect(actions.skipVersion).toHaveBeenCalledTimes(1);
    });

    it('treats Escape as Later, never as Skip', () => {
      render(<AutoUpdater />);
      fireEvent.keyDown(document, { key: 'Escape' });

      expect(actions.dismissBanner).toHaveBeenCalledTimes(1);
      expect(actions.skipVersion).not.toHaveBeenCalled();
    });

    it('says nothing about a version the user already skipped', () => {
      setStore({ status: 'available', updateInfo: UPDATE, skippedVersion: '2.4.0' });
      render(<AutoUpdater />);
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('speaks up again when a newer version arrives after a skip', () => {
      setStore({ status: 'available', updateInfo: UPDATE, skippedVersion: '2.3.0' });
      render(<AutoUpdater />);
      expect(screen.getByRole('dialog')).toBeTruthy();
    });

    it('says nothing while dismissed for this same version', () => {
      setStore({ status: 'available', updateInfo: UPDATE, bannerDismissedVersion: '2.4.0' });
      render(<AutoUpdater />);
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  describe('while downloading', () => {
    beforeEach(() =>
      setStore({
        status: 'downloading',
        updateInfo: UPDATE,
        downloadProgress: 61,
        downloadedBytes: 11_200_000,
        totalBytes: 18_400_000,
      }),
    );

    it('reports real size rather than a bare percentage', () => {
      render(<AutoUpdater />);
      expect(screen.getByText('11.2 MB of 18.4 MB')).toBeTruthy();
    });

    it('exposes progress to assistive tech', () => {
      render(<AutoUpdater />);
      const bar = screen.getByRole('progressbar');
      expect(bar.getAttribute('aria-valuenow')).toBe('61');
    });

    it('lets the user get back to work without cancelling the download', () => {
      render(<AutoUpdater />);
      fireEvent.click(screen.getByRole('button', { name: 'Continue in Background' }));
      expect(actions.dismissBanner).toHaveBeenCalledTimes(1);
    });
  });

  describe('ready to install', () => {
    beforeEach(() => setStore({ status: 'ready', updateInfo: UPDATE }));

    it('promises the session will survive the relaunch', () => {
      render(<AutoUpdater />);
      expect(screen.getByText(/terminals/i)).toBeTruthy();
    });

    it('relaunches from the default action', () => {
      render(<AutoUpdater />);
      fireEvent.click(screen.getByRole('button', { name: 'Relaunch and Install' }));
      expect(actions.restart).toHaveBeenCalledTimes(1);
    });

    it('can defer the relaunch to the next quit', () => {
      render(<AutoUpdater />);
      fireEvent.click(screen.getByRole('button', { name: 'Install on Quit' }));
      expect(actions.dismissBanner).toHaveBeenCalledTimes(1);
      expect(actions.restart).not.toHaveBeenCalled();
    });
  });

  describe('the update failed', () => {
    beforeEach(() =>
      setStore({
        status: 'error',
        updateInfo: UPDATE,
        error: 'connection closed before message completed',
      }),
    );

    it('surfaces the failure instead of failing silently', () => {
      render(<AutoUpdater />);
      expect(screen.getByText('The update could not be downloaded')).toBeTruthy();
      expect(screen.getByText(/connection closed before message completed/)).toBeTruthy();
    });

    it('retries from the default action', () => {
      render(<AutoUpdater />);
      fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
      expect(actions.downloadAndInstall).toHaveBeenCalledTimes(1);
    });

    it('offers a manual download as an escape hatch', () => {
      render(<AutoUpdater />);
      const link = screen.getByRole('link', { name: 'Download Manually' });
      expect(link.getAttribute('href')).toContain('github.com');
    });
  });
});
