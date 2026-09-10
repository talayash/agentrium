import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePreventWebviewReload } from './usePreventWebviewReload';

const state = vi.hoisted(() => ({ terminals: new Map<string, object>() }));
vi.mock('../store/terminalStore', () => ({ useTerminalStore: { getState: () => state } }));

describe('reload protection', () => {
  beforeEach(() => state.terminals.clear());
  afterEach(cleanup);

  it.each(['input', 'textarea', 'div'])('blocks native refresh menus on %s elements', (tag) => {
    renderHook(usePreventWebviewReload);
    const target = document.createElement(tag);
    document.body.appendChild(target);
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    target.remove();
  });

  it('reads current terminals at unload time, including terminals opened after mounting', () => {
    renderHook(usePreventWebviewReload);
    const unload = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(unload()).toBe(false);
    state.terminals.set('one', {});
    expect(unload()).toBe(true);
    state.terminals.clear();
    expect(unload()).toBe(false);
  });

  it('removes both global handlers on unmount', () => {
    state.terminals.set('one', {});
    const { unmount } = renderHook(usePreventWebviewReload);
    unmount();
    for (const type of ['contextmenu', 'beforeunload']) {
      const event = new Event(type, { cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
  });
});
