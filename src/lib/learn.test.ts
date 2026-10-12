import { expect, it } from 'vitest';
import { shouldAutoLearn } from './learn';

it('auto-learns from agent sessions', () => {
  expect(shouldAutoLearn({ config: { claude_args: ['--model', 'opus'] } }, undefined)).toBe(true);
  // A closed terminal is gone from the store; its saved config still decides.
  expect(shouldAutoLearn(undefined, { claude_args: [] })).toBe(true);
});

it('skips bottom-pane shells, main-tab shells and script runners', () => {
  expect(shouldAutoLearn({ config: { claude_args: [] }, isShellTerminal: true }, undefined)).toBe(false);
  expect(shouldAutoLearn({ config: { claude_args: ['__shell__'] } }, undefined)).toBe(false);
  expect(shouldAutoLearn(undefined, { claude_args: ['__shell__'] })).toBe(false);
  expect(shouldAutoLearn({ config: { claude_args: [] }, scriptParentId: 'parent' }, undefined)).toBe(false);
});

it('skips when nothing is known about the terminal', () => {
  expect(shouldAutoLearn(undefined, undefined)).toBe(false);
});
