import { describe, it, expect } from 'vitest';
import { classifySettled, hasOptionMenu, hasReadyPrompt, hasTurnFinishedMarker, isShellPrompt, needsTerminal } from './terminalState';
import { ASK_USER_QUESTION_SCREEN } from './__fixtures__/askUserQuestionScreen';

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

describe('hasOptionMenu', () => {
  it('hasOptionMenu detects a numbered menu with a cursor', () => {
    expect(hasOptionMenu(['Pick one', '❯ 1. Yes', '  2. No'])).toBe(true);
    expect(hasOptionMenu(['Pick one', '› 1. Yes', '  2. No'])).toBe(true);
  });

  it('rejects a plain numbered list and a lone option', () => {
    expect(hasOptionMenu(['1. one', '2. two'])).toBe(false);
    expect(hasOptionMenu(['❯ 1. only'])).toBe(false);
    expect(hasOptionMenu([])).toBe(false);
  });
});

describe('Claude AskUserQuestion screen', () => {
  it('classifies the Claude AskUserQuestion screen as waiting', () => {
    expect(hasOptionMenu(ASK_USER_QUESTION_SCREEN)).toBe(true);
    expect(classifySettled(ASK_USER_QUESTION_SCREEN)).toBe('waiting');
  });
});

const PERMISSION = [' Do you want to proceed?', ' ❯ 1. Yes', '   2. Yes, and don’t ask again for: node sizes.js', '   3. No', ' Esc to cancel · Tab to amend'];
const TRUST = [' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work', ' ❯ No, exit', '   Yes, I trust this folder', ' Enter to confirm · Esc to cancel'];

describe('needsTerminal and isShellPrompt', () => {
  it('needs the terminal for a permission prompt unless a question is pending', () => {
    expect(needsTerminal(PERMISSION, false)).toBe(true);
    expect(needsTerminal(PERMISSION, true)).toBe(false);
  });
  it('needs the terminal for the folder-trust prompt', () => {
    expect(needsTerminal(TRUST, false)).toBe(true);
    expect(classifySettled(TRUST)).toBe('waiting');
  });
  it('detects bare shell prompts', () => {
    expect(isShellPrompt(['C:\\Users\\tal\\proj>'])).toBe(true);
    expect(isShellPrompt(['PS C:\\x> '])).toBe(true);
    expect(isShellPrompt(['tal@box:~/p$ '])).toBe(true);
    expect(isShellPrompt(['out', 'tal@box:~/p$ ', '', ''])).toBe(true);
    expect(isShellPrompt(['❯ '])).toBe(false);
    expect(isShellPrompt(['> '])).toBe(false);
    expect(isShellPrompt([])).toBe(false);
  });
});
