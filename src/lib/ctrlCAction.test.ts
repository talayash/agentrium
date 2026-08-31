import { describe, expect, it } from 'vitest';
import { decideCtrlC } from './ctrlCAction';

describe('decideCtrlC', () => {
  it('interrupts when nothing is selected', () => {
    expect(decideCtrlC({ hasSelection: false, copyOnSelect: false })).toBe('interrupt');
    expect(decideCtrlC({ hasSelection: true, copyOnSelect: false })).not.toBe('interrupt');
  });

  it('copies a selection when copy-on-select is off', () => {
    // Without copy-on-select, Ctrl+C is the only way to get the selection out,
    // so it has to win over the interrupt.
    expect(decideCtrlC({ hasSelection: true, copyOnSelect: false })).toBe('copy');
  });

  it('interrupts on a stale selection when copy-on-select is on', () => {
    // The regression: with copy-on-select the drag already put the text on the
    // clipboard, so copying again is a no-op that silently eats the interrupt.
    // A leftover selection from minutes ago must not stop Ctrl+C from killing
    // a runaway agent.
    expect(decideCtrlC({ hasSelection: true, copyOnSelect: true })).toBe('interrupt');
  });

  it('interrupts with no selection regardless of the copy-on-select setting', () => {
    expect(decideCtrlC({ hasSelection: false, copyOnSelect: true })).toBe('interrupt');
  });
});
