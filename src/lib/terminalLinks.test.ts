import { describe, it, expect, vi, beforeEach } from 'vitest';

const core = vi.hoisted(() => ({ invoke: vi.fn() }));
const reporter = vi.hoisted(() => ({ reportInvokeFailure: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: core.invoke }));
const controller = vi.hoisted(() => ({ openInNewTab: vi.fn() }));
vi.mock('./errorReporter', () => ({ reportInvokeFailure: reporter.reportInvokeFailure }));
vi.mock('./browser/controller', () => ({ openInNewTab: controller.openInNewTab }));

import { openTerminalLink } from './terminalLinks';
import { useBrowserStore } from '../store/browserStore';

beforeEach(() => {
  core.invoke.mockReset();
  reporter.reportInvokeFailure.mockReset();
  controller.openInNewTab.mockReset();
  useBrowserStore.setState({ open: false });
});

describe('openTerminalLink', () => {
  it('opens the URI through open_external_url without prompting', () => {
    core.invoke.mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, 'confirm');

    openTerminalLink('https://auth.openai.com/oauth/authorize?x=1');

    expect(core.invoke).toHaveBeenCalledWith('open_external_url', {
      url: 'https://auth.openai.com/oauth/authorize?x=1',
    });
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('reports a failed open instead of throwing', async () => {
    const err = new Error('Could not open the browser');
    core.invoke.mockRejectedValue(err);

    openTerminalLink('https://codewiki.google/');
    await vi.waitFor(() =>
      expect(reporter.reportInvokeFailure).toHaveBeenCalledWith('open_external_url', err),
    );
  });

  it('opens local dev-server links in the built-in browser while it is open', () => {
    useBrowserStore.setState({ open: true });
    openTerminalLink('http://localhost:3000/');
    expect(controller.openInNewTab).toHaveBeenCalledWith('http://localhost:3000/');
    expect(core.invoke).not.toHaveBeenCalled();
  });

  it('keeps other links in the system browser even while the browser is open', () => {
    core.invoke.mockResolvedValue(undefined);
    useBrowserStore.setState({ open: true });
    openTerminalLink('https://auth.openai.com/oauth/authorize?x=1');
    openTerminalLink('http://localhost.evil.example/');
    expect(controller.openInNewTab).not.toHaveBeenCalled();
    expect(core.invoke).toHaveBeenCalledTimes(2);
  });

  it('keeps local links in the system browser while the browser is closed', () => {
    core.invoke.mockResolvedValue(undefined);
    openTerminalLink('http://localhost:3000/');
    expect(controller.openInNewTab).not.toHaveBeenCalled();
  });
});
