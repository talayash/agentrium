import { describe, it, expect, vi, beforeEach } from 'vitest';

const core = vi.hoisted(() => ({ invoke: vi.fn() }));
const reporter = vi.hoisted(() => ({ reportInvokeFailure: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: core.invoke }));
vi.mock('./errorReporter', () => ({ reportInvokeFailure: reporter.reportInvokeFailure }));

import { openTerminalLink } from './terminalLinks';

beforeEach(() => {
  core.invoke.mockReset();
  reporter.reportInvokeFailure.mockReset();
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
});
