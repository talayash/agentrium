import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const checkMock = vi.fn();
const downloadAndInstallMock = vi.fn();
const reportInvokeFailureMock = vi.fn();

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: (...args: unknown[]) => checkMock(...args),
}));

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => 'test-installation-id'),
}));

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn(async () => '1.22.0'),
}));

vi.mock('../lib/errorReporter', () => ({
  reportInvokeFailure: (...args: unknown[]) => reportInvokeFailureMock(...args),
}));

import { isTransientNetworkError, useUpdaterStore } from './updaterStore';

function resetStore() {
  useUpdaterStore.setState({
    status: 'idle',
    updateInfo: null,
    downloadProgress: 0,
    error: null,
    lastCheckAt: null,
    bannerDismissedVersion: null,
    bannerSnoozedUntil: null,
    notifiedVersion: null,
  });
}

function fakeUpdate(version: string, body = 'release notes') {
  return {
    version,
    date: '2026-05-15',
    body,
    downloadAndInstall: downloadAndInstallMock,
  };
}

describe('updaterStore', () => {
  beforeEach(() => {
    resetStore();
    checkMock.mockReset();
    downloadAndInstallMock.mockReset();
    reportInvokeFailureMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('checkForUpdates', () => {
    it('does NOT auto-fire downloadAndInstall when an update is found', async () => {
      checkMock.mockResolvedValueOnce(fakeUpdate('1.23.0'));

      const result = await useUpdaterStore.getState().checkForUpdates();

      expect(result).toEqual({ available: true });
      expect(useUpdaterStore.getState().status).toBe('available');
      expect(useUpdaterStore.getState().updateInfo).toMatchObject({
        version: '1.23.0',
        body: 'release notes',
      });
      // The whole point of this change: no silent download.
      expect(downloadAndInstallMock).not.toHaveBeenCalled();
    });

    it('marks the app up-to-date when no update is available', async () => {
      checkMock.mockResolvedValueOnce(null);

      const result = await useUpdaterStore.getState().checkForUpdates();

      expect(result).toEqual({ available: false });
      expect(useUpdaterStore.getState().status).toBe('up-to-date');
      expect(downloadAndInstallMock).not.toHaveBeenCalled();
    });

    it('preserves dismissal when the same version is re-detected', async () => {
      checkMock.mockResolvedValue(fakeUpdate('1.23.0'));

      await useUpdaterStore.getState().checkForUpdates();
      useUpdaterStore.getState().dismissBanner();
      useUpdaterStore.getState().markNotified('1.23.0');
      expect(useUpdaterStore.getState().bannerDismissedVersion).toBe('1.23.0');

      // Force status back so the guard at the top of checkForUpdates lets us re-enter.
      useUpdaterStore.setState({ status: 'idle' });
      await useUpdaterStore.getState().checkForUpdates();

      expect(useUpdaterStore.getState().bannerDismissedVersion).toBe('1.23.0');
      expect(useUpdaterStore.getState().notifiedVersion).toBe('1.23.0');
    });

    it('clears stale dismissal/snooze/notification when a newer version appears', async () => {
      checkMock.mockResolvedValueOnce(fakeUpdate('1.23.0'));
      await useUpdaterStore.getState().checkForUpdates();
      useUpdaterStore.getState().dismissBanner();
      useUpdaterStore.getState().snoozeBanner(60_000);
      useUpdaterStore.getState().markNotified('1.23.0');

      // A newer version arrives - the user should be re-prompted.
      checkMock.mockResolvedValueOnce(fakeUpdate('1.24.0'));
      useUpdaterStore.setState({ status: 'idle' });
      await useUpdaterStore.getState().checkForUpdates();

      const state = useUpdaterStore.getState();
      expect(state.updateInfo?.version).toBe('1.24.0');
      expect(state.bannerDismissedVersion).toBeNull();
      expect(state.bannerSnoozedUntil).toBeNull();
      expect(state.notifiedVersion).toBeNull();
    });

    it('records error state when the check throws', async () => {
      checkMock.mockRejectedValueOnce(new Error('network down'));

      const result = await useUpdaterStore.getState().checkForUpdates();

      expect(result).toEqual({ available: false });
      expect(useUpdaterStore.getState().status).toBe('error');
      expect(useUpdaterStore.getState().error).toBe('network down');
    });

    it('skips telemetry for transient reqwest network errors', async () => {
      // The exact shape that produced fingerprint 6d37063a in production.
      checkMock.mockRejectedValueOnce(
        new Error(
          'error sending request for url (https://github.com/talayash/claude-terminal/releases/latest/download/latest.json)'
        )
      );

      await useUpdaterStore.getState().checkForUpdates();

      expect(useUpdaterStore.getState().status).toBe('error');
      expect(reportInvokeFailureMock).not.toHaveBeenCalled();
    });

    it('still reports non-network errors to telemetry', async () => {
      checkMock.mockRejectedValueOnce(new Error('signature verification failed'));

      await useUpdaterStore.getState().checkForUpdates();

      expect(reportInvokeFailureMock).toHaveBeenCalledTimes(1);
      expect(reportInvokeFailureMock).toHaveBeenCalledWith(
        'updater_check',
        expect.any(Error),
      );
    });

    it('short-circuits when already downloading or ready', async () => {
      useUpdaterStore.setState({ status: 'downloading' });
      let result = await useUpdaterStore.getState().checkForUpdates();
      expect(result).toEqual({ available: false });
      expect(checkMock).not.toHaveBeenCalled();

      useUpdaterStore.setState({ status: 'ready' });
      result = await useUpdaterStore.getState().checkForUpdates();
      expect(result).toEqual({ available: true });
      expect(checkMock).not.toHaveBeenCalled();
    });
  });

  describe('dismissBanner', () => {
    it('records the current update version and clears any active snooze', () => {
      useUpdaterStore.setState({
        updateInfo: { version: '1.23.0', date: '', body: '' },
        bannerSnoozedUntil: Date.now() + 60_000,
      });

      useUpdaterStore.getState().dismissBanner();

      expect(useUpdaterStore.getState().bannerDismissedVersion).toBe('1.23.0');
      expect(useUpdaterStore.getState().bannerSnoozedUntil).toBeNull();
    });

    it('stores null when no updateInfo is present', () => {
      useUpdaterStore.getState().dismissBanner();
      expect(useUpdaterStore.getState().bannerDismissedVersion).toBeNull();
    });
  });

  describe('snoozeBanner', () => {
    it('sets bannerSnoozedUntil ms in the future and clears any dismissal', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-15T12:00:00Z'));
      useUpdaterStore.setState({ bannerDismissedVersion: '1.23.0' });

      useUpdaterStore.getState().snoozeBanner(4 * 60 * 60 * 1000);

      const expected = new Date('2026-05-15T16:00:00Z').getTime();
      expect(useUpdaterStore.getState().bannerSnoozedUntil).toBe(expected);
      expect(useUpdaterStore.getState().bannerDismissedVersion).toBeNull();
    });
  });

  describe('markNotified', () => {
    it('records the version that has been toasted', () => {
      useUpdaterStore.getState().markNotified('1.23.0');
      expect(useUpdaterStore.getState().notifiedVersion).toBe('1.23.0');
    });
  });

  describe('isTransientNetworkError', () => {
    it.each([
      ['error sending request for url (https://github.com/...)', true],
      ['Could not fetch a valid release JSON from the remote', true],
      ['connection refused', true],
      ['connection reset by peer', true],
      ['DNS error: no such host', true],
      ['failed to lookup address information', true],
      ['operation timed out', true],
      ['request timeout', true],
      ['signature verification failed', false],
      ['Invalid manifest', false],
      ['', false],
    ])('classifies %j → %s', (message, expected) => {
      expect(isTransientNetworkError(new Error(message))).toBe(expected);
    });

    it('handles string and unknown inputs without throwing', () => {
      expect(isTransientNetworkError('error sending request')).toBe(true);
      expect(isTransientNetworkError(undefined)).toBe(false);
      expect(isTransientNetworkError({})).toBe(false);
    });
  });
});
