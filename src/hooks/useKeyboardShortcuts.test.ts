import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';

const toggleInsightLayer = vi.fn();
vi.mock('../lib/insightToggle', () => ({ toggleInsightLayer: (id: string) => toggleInsightLayer(id) }));

import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { useTerminalStore } from '../store/terminalStore';

afterEach(() => {
  cleanup();
  toggleInsightLayer.mockClear();
});

function press(repeat: boolean) {
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'L', code: 'KeyL', ctrlKey: true, shiftKey: true, repeat, bubbles: true, cancelable: true }),
  );
}

describe('Ctrl+Shift+L', () => {
  it('toggles on the first press and ignores auto-repeat', () => {
    useTerminalStore.setState({ activeTerminalId: 'a' });
    renderHook(() => useKeyboardShortcuts());
    press(false);
    press(true);
    press(true);
    expect(toggleInsightLayer).toHaveBeenCalledTimes(1);
    expect(toggleInsightLayer).toHaveBeenCalledWith('a');
  });
});
