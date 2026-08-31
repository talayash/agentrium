// What Ctrl+C should do in a terminal: copy the selection, or send the
// interrupt (\x03) through to the agent.
//
// Extracted from TerminalView so the rule is unit-testable without an xterm
// instance, in the same spirit as `classifyPasteInput`.
//
// The rule used to be "copy whenever there is a selection". That silently ate
// the interrupt: with "copy on select" enabled, a drag from minutes earlier
// leaves the selection sitting there, so Ctrl+C copied text that was already on
// the clipboard instead of stopping a runaway agent - the "Ctrl+C sometimes
// doesn't work" report. When copy-on-select already did the copying, Ctrl+C has
// no copy job left to do and belongs to the agent.

export interface CtrlCInput {
  /** Does the terminal currently hold a selection. */
  hasSelection: boolean;
  /** User setting: is "copy on select" turned on. */
  copyOnSelect: boolean;
}

export type CtrlCAction = 'copy' | 'interrupt';

export function decideCtrlC({ hasSelection, copyOnSelect }: CtrlCInput): CtrlCAction {
  if (!hasSelection) return 'interrupt';
  // copy-on-select already placed this text on the clipboard on mouseup.
  return copyOnSelect ? 'interrupt' : 'copy';
}
