// Builds the PTY keystrokes that answer Claude Code's AskUserQuestion TUI prompt.
//
// This is the one sanctioned case of writing keys into an agent PTY (see the
// insight-layer spec): only answer keys for this menu, never a prompt.
//
// Verified against Claude Code 2.1.318 by reading the installed bundle
// (~/.local/bin/claude.exe, chunk headers "// Version: 2.1.318"), not by
// driving the live TUI. Evidence, paraphrased from the minified source:
//
// (a) Digits. Single-select options use the shared Select; its keydown does
//     `if(/^[0-9]$/.test(x)){ let I=parseInt(x)-1; ... if(D.type==="input"){
//     if(text.trim()) onChange(D.value); else focusOption(D.value); return }
//     onChange(D.value) }`. So a digit selects AND answers a plain option at
//     once. The answer handler then either submits immediately (exactly one
//     question and it is single-select: `if(!vs&&Na&&Jr){... submit}`) or
//     calls setAnswer with shouldAdvance=true, which moves to the next
//     question. In the multi-select list a digit only toggles:
//     `if(!L&&/^[0-9]$/.test(a)){ ... F(d[O].value) }` (focus does not move).
//     Preview layout (single-select where any option has a preview): a digit
//     only moves focus (`fo(Dr)`); Enter selects (`key==="return" -> fn(Co)`).
// (b) Free-text row. Options are `[...options, {type:"input", value:"__other__",
//     label:"Other", placeholder: multiSelect ? "Type something" :
//     "Type something."}]`, so it is 0-based row options.length, digit
//     options.length + 1. A digit on the empty row focuses it; typed text goes
//     into the row; Enter calls `onSubmit(text) -> if(text.trim()) onChange("__other__")`.
//     "Chat about this" is rendered below a divider as digit options.length + 2
//     and is never pressed here. The preview layout has no Other row at all.
// (c) Multi-select. Space or Enter toggles the focused row, digits toggle row N.
//     The list ends with a "Next" (or "Submit" on the last question) button:
//     Down on the last row (the Other row) focuses it
//     (`if(T&&p&&f===E&&!h) C(!0)`), Enter on it calls onSubmit = nextQuestion.
//     Typing in the Other row auto-selects it (updateInputValue adds the value
//     when non-empty). Enter while the Other row is focused toggles it instead,
//     so we always move Down to the button first.
// (d) Review screen. When the index reaches questions.length the "Review your
//     answers" screen shows a Select of ["Submit answers", "Cancel"] with
//     defaultFocusValue "confirm"; Enter (or digit 1) submits. It is skipped
//     only for one single-select question (`hideSubmitTab = st.length===1 &&
//     !st[0]?.multiSelect`), which submits on the answer itself.
// (e) Cursor mode. The key parser maps both "[B" and "OB" to "down"
//     (`"[B":"down", ... OB:"down"`), so `\x1b[B` works whether or not the
//     terminal is in application cursor mode. Arrows are only used to reach the
//     multi-select Next/Submit button and the multi-select Other row.
//
// Every element of the returned array is one PTY write. Separate writes matter:
// the parser reads "13" in one chunk as a single key that is not a digit, and
// a key group never mixes "\r" with typed text so writeToTerminal's submit
// marker fires only on a real Enter.

import type { AskQuestion } from './insightModel';

export interface QuestionAnswer {
  /** Indexes into the question's options. */
  selected: number[];
  /** Free text for the "Type something" row, or null. */
  other: string | null;
}

const DOWN = '\x1b[B';
const ENTER = '\r';

function digit(n: number): string {
  if (n < 1 || n > 9) throw new Error(`Option number ${n} cannot be typed as a single digit`);
  return String(n);
}

/** Newlines and tabs become spaces; other control characters (ESC included) are dropped. */
export function sanitizeOtherText(text: string): string {
  return text
    .replace(/\r\n|[\r\n\t]/g, ' ')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    .trim();
}

function checkIndexes(q: AskQuestion, selected: number[], qi: number): number[] {
  for (const i of selected) {
    if (!Number.isInteger(i) || i < 0 || i >= q.options.length) {
      throw new Error(`Question ${qi + 1}: option index ${i} is out of range`);
    }
  }
  return [...new Set(selected)].sort((x, y) => x - y);
}

function otherText(answer: QuestionAnswer, qi: number): string | null {
  if (answer.other === null) return null;
  const text = sanitizeOtherText(answer.other);
  if (text === '') throw new Error(`Question ${qi + 1}: the free-text answer is empty`);
  return text;
}

export function buildAnswerKeys(questions: AskQuestion[], answers: QuestionAnswer[]): string[] {
  if (questions.length === 0) throw new Error('No questions to answer');
  if (answers.length !== questions.length) {
    throw new Error(`Expected ${questions.length} answers, got ${answers.length}`);
  }
  const keys: string[] = [];
  questions.forEach((q, qi) => {
    const answer = answers[qi]!;
    const selected = checkIndexes(q, answer.selected, qi);
    const text = otherText(answer, qi);
    const otherRow = q.options.length; // 0-based row of "Type something"

    if (q.multiSelect) {
      for (const i of selected) keys.push(digit(i + 1));
      // Focus is still on row 0. Walk down to the Other row, optionally type,
      // then one more Down lands on the Next/Submit button.
      for (let i = 0; i < otherRow; i++) keys.push(DOWN);
      if (text !== null) keys.push(text);
      keys.push(DOWN, ENTER);
      return;
    }

    const chosen = selected.length + (text !== null ? 1 : 0);
    if (chosen !== 1) {
      throw new Error(`Question ${qi + 1}: a single-select answer needs exactly one option or free text`);
    }

    if (q.options.some((o) => o.preview !== undefined)) {
      if (text !== null) throw new Error(`Question ${qi + 1}: preview questions have no free-text row`);
      keys.push(digit(selected[0]! + 1), ENTER);
      return;
    }

    if (text !== null) {
      keys.push(digit(otherRow + 1), text, ENTER);
    } else {
      keys.push(digit(selected[0]! + 1));
    }
  });

  const submitsOnAnswer = questions.length === 1 && !questions[0]!.multiSelect;
  if (!submitsOnAnswer) keys.push(ENTER); // "Submit answers" is focused by default
  return keys;
}
