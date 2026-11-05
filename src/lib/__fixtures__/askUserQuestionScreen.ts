// Plain-text rendering of Claude Code 2.1.318's AskUserQuestion prompt (first of
// two questions, single-select), as it appears in the xterm buffer. Reconstructed
// from the installed bundle's render code, not captured from a live session:
// - tab bar: "← " + one padded " ☐ <header> " chip per question
//   (☒ once answered) + " ✔ Submit " + " →" (no bar for one single-select question)
// - option rows: pointer "❯" on the focused row, else a space; "<n>." index;
//   label; description on the next line indented under the label
// - free-text row: "<options+1>. Type something." ("Type something" without the
//   period on multi-select, whose rows read "<n>. [ ] <label>" and end with a "Next"/"Submit" button)
// - divider, then "<options+2>. Chat about this", then the key hints line
// Used by Task 12 (terminal screen detection) tests.

const DIVIDER = '─'.repeat(60);

export const ASK_USER_QUESTION_SCREEN: string[] = [
  '←  ☐ Database   ☐ Features   ✔ Submit  →',
  '',
  'Which database should the service use?',
  '',
  '❯ 1. PostgreSQL',
  '     Relational, strong consistency, mature tooling',
  '  2. SQLite',
  '     Embedded single file, zero setup',
  '  3. MongoDB',
  '     Document store with a flexible schema',
  '  4. Type something.',
  DIVIDER,
  '  5. Chat about this',
  '',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
];
