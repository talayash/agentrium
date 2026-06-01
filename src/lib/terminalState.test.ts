import { describe, it, expect } from 'vitest';
import { classifySettled } from './terminalState';

describe('classifySettled', () => {
  it('flags a "Do you want to proceed?" permission prompt as waiting', () => {
    const lines = [
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. No, tell Claude what to do differently',
    ];
    expect(classifySettled(lines)).toBe('waiting');
  });

  it('flags an AskUserQuestion numbered menu as waiting', () => {
    const lines = [
      'Which approach should I take?',
      '❯ 1. Rewrite the module',
      '  2. Patch in place',
      '  3. Leave it',
    ];
    expect(classifySettled(lines)).toBe('waiting');
  });

  it('flags the folder-trust prompt as waiting', () => {
    const lines = [
      'Do you trust the files in this folder?',
      '❯ 1. Yes, proceed',
      '  2. No, exit',
    ];
    expect(classifySettled(lines)).toBe('waiting');
  });

  it('treats the plain idle input box as idle', () => {
    const lines = [
      '╭───────────────────────────────╮',
      '│ >                             │',
      '╰───────────────────────────────╯',
      '  ? for shortcuts',
    ];
    expect(classifySettled(lines)).toBe('idle');
  });

  it('does not raise waiting on a finished response that contains a numbered list', () => {
    const lines = [
      'Here are the steps I took:',
      '1. Updated the parser',
      '2. Added a test',
      '╭───────────────────────────────╮',
      '│ >                             │',
      '╰───────────────────────────────╯',
      '  ? for shortcuts',
    ];
    expect(classifySettled(lines)).toBe('idle');
  });

  it('treats mid-stream prose with no prompt as idle (never a false alarm)', () => {
    const lines = [
      '● Running the test suite…',
      '  Updated src/foo.ts with 3 additions',
      'Now I will check the output.',
    ];
    expect(classifySettled(lines)).toBe('idle');
  });

  it('does not raise waiting on a numbered list with no cursor and no idle box', () => {
    const lines = [
      'Here are the steps I took:',
      '1. Updated the parser',
      '2. Added a test',
    ];
    expect(classifySettled(lines)).toBe('idle');
  });

  it('treats a single cursor option line as idle (below the menu threshold)', () => {
    expect(classifySettled(['❯ 1. Yes'])).toBe('idle');
  });

  it('treats empty input as idle', () => {
    expect(classifySettled([])).toBe('idle');
  });
});
