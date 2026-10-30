import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('../agentContext', () => ({ stageForAgent: vi.fn(), stageTarget: vi.fn() }));
vi.mock('../clipboard', () => ({ copyText: vi.fn() }));
vi.mock('../../store/toastStore', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { stageForAgent, stageTarget } from '../agentContext';
import { copyText } from '../clipboard';
import { toast } from '../../store/toastStore';
import { useBrowserStore, type BrowserEventPayload } from '../../store/browserStore';
import { cancelPick, closeTab, ensureBrowserEvents, startPick } from './controller';
import { formatPickedElement, type PickedElement } from './pickedElement';

const element: PickedElement = {
  url: 'https://example.com/', title: 'Example', selector: '#go', tag: 'button', text: 'Go', html: '<button id="go">Go</button>',
};

let emit: (ev: BrowserEventPayload) => void;

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(undefined);
  vi.mocked(listen).mockImplementation(async (_name, cb) => {
    emit = (payload) => (cb as (e: { payload: BrowserEventPayload }) => void)({ payload });
    return () => {};
  });
  vi.mocked(copyText).mockResolvedValue(true);
  useBrowserStore.setState({
    tabs: [
      { id: 'a', url: 'https://example.com/', title: '', loading: false, error: null, notice: null, hasWebview: true, history: { entries: [], index: -1, pending: null } },
      { id: 'b', url: 'https://example.org/', title: '', loading: false, error: null, notice: null, hasWebview: true, history: { entries: [], index: -1, pending: null } },
    ],
    activeTabId: 'a',
    pickingTabId: null,
  } as never);
  ensureBrowserEvents();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('element picker', () => {
  it('arms the picker for one tab', () => {
    startPick('a');
    expect(useBrowserStore.getState().pickingTabId).toBe('a');
    expect(invoke).toHaveBeenCalledWith('browser_pick_element', { id: 'a' });
  });

  it('cancels the previous tab when another tab starts picking', () => {
    startPick('a');
    startPick('b');
    expect(invoke).toHaveBeenCalledWith('browser_cancel_pick', { id: 'a' });
    expect(useBrowserStore.getState().pickingTabId).toBe('b');
  });

  it('disarms and shows a notice when arming fails', async () => {
    vi.mocked(invoke).mockRejectedValueOnce('This tab is no longer open.');
    startPick('a');
    await flush();
    const s = useBrowserStore.getState();
    expect(s.pickingTabId).toBeNull();
    expect(s.tabs[0].notice).toBe('This tab is no longer open.');
  });

  it('cancelPick clears the state and disarms the native side', () => {
    startPick('a');
    cancelPick('a');
    expect(useBrowserStore.getState().pickingTabId).toBeNull();
    expect(invoke).toHaveBeenCalledWith('browser_cancel_pick', { id: 'a' });
  });

  it('stages a picked element for the active agent session', async () => {
    vi.mocked(stageTarget).mockReturnValue('term-1');
    startPick('a');
    emit({ kind: 'elementPicked', id: 'a', element });
    await flush();
    expect(useBrowserStore.getState().pickingTabId).toBeNull();
    expect(stageForAgent).toHaveBeenCalledWith('term-1', formatPickedElement(element));
    expect(copyText).not.toHaveBeenCalled();
  });

  it('copies the element and explains when there is no agent session', async () => {
    vi.mocked(stageTarget).mockReturnValue(null);
    startPick('a');
    emit({ kind: 'elementPicked', id: 'a', element });
    await flush();
    expect(stageForAgent).not.toHaveBeenCalled();
    expect(copyText).toHaveBeenCalledWith(formatPickedElement(element));
    expect(toast.info).toHaveBeenCalledWith('Open an agent session to send this element to.', expect.anything());
  });

  it('ignores a pick from a tab that is not picking', async () => {
    vi.mocked(stageTarget).mockReturnValue('term-1');
    emit({ kind: 'elementPicked', id: 'a', element });
    await flush();
    expect(stageForAgent).not.toHaveBeenCalled();
    expect(copyText).not.toHaveBeenCalled();
  });

  it('clears the picking tab when the page cancels', () => {
    startPick('a');
    emit({ kind: 'pickCancelled', id: 'a' });
    expect(useBrowserStore.getState().pickingTabId).toBeNull();
  });

  it('disarms picker when the tab starts loading', () => {
    startPick('a');
    vi.mocked(invoke).mockClear();
    emit({ kind: 'loadStarted', id: 'a', url: 'https://example.com/next' });
    expect(useBrowserStore.getState().pickingTabId).toBeNull();
    expect(invoke).toHaveBeenCalledWith('browser_cancel_pick', { id: 'a' });
  });

  it('a load in another tab leaves the picker armed', () => {
    startPick('a');
    emit({ kind: 'loadStarted', id: 'b', url: 'https://example.org/next' });
    expect(useBrowserStore.getState().pickingTabId).toBe('a');
  });

  it('closing the picking tab clears the picker', () => {
    startPick('a');
    closeTab('a');
    expect(useBrowserStore.getState().pickingTabId).toBeNull();
  });
});
