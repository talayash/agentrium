import { describe, it, expect } from 'vitest';
import { classifySettled, hasReadyPrompt, hasTurnFinishedMarker } from './terminalState';

describe('completed turn signals', () => {
  it('recognizes Claude and Codex input prompts but rejects running output', () => {
    expect(hasReadyPrompt(['❯ '])).toBe(true);
    expect(hasReadyPrompt(['› Ask Codex to do anything'])).toBe(true);
    expect(hasReadyPrompt(['│ >     │'])).toBe(true);
    expect(hasReadyPrompt(['Running…', '❯ '])).toBe(false);
    expect(hasReadyPrompt(['esc to interrupt', '❯ '])).toBe(false);
    expect(hasReadyPrompt(['Some prose then a pause'])).toBe(false);
  });
  it('recognizes duration footers, not arbitrary prose', () => {
    expect(hasTurnFinishedMarker(['✻ Worked for 1m 32s'])).toBe(true);
    expect(hasTurnFinishedMarker(['✽ Churned for 52s'])).toBe(true);
    expect(hasTurnFinishedMarker(['── Worked for 20s ──'])).toBe(true);
    expect(hasTurnFinishedMarker(['Looking for 3 examples'])).toBe(false);
  });
});

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

  it('detects Codex approval prompts and its › selection cursor', () => {
    // Captured from Codex v0.160 asking to run a git command.
    expect(classifySettled([
      'Would you like to run the following command?',
      'Environment: local',
      '$ git add -- slug.js; git commit -m "Fix slugify"',
      '› 1. Yes, proceed (y)',
      "  2. Yes, and don't ask again for commands that start with `git add`",
      'Press enter to confirm or esc to cancel',
    ])).toBe('waiting');
    // Codex's folder trust prompt: options with the › cursor, no phrase.
    expect(classifySettled(['Trust this folder?', '› 1. Trust and continue', '  2. Quit'])).toBe('waiting');
    // A finished Codex answer with a numbered list and the idle input box.
    expect(classifySettled(['1. Fixed slug.js', '2. Ran npm test', '› Ask Codex to do anything', '? for shortcuts'])).toBe('idle');
  });
});
