import { describe, expect, it } from 'vitest';
import { buildAnswerKeys, type QuestionAnswer } from './questionKeys';
import type { AskQuestion } from './insightModel';

const DOWN = '\x1b[B';
const ENTER = '\r';

function q(multiSelect: boolean, n = 3, withPreview = false): AskQuestion {
  return {
    question: multiSelect ? 'Which features?' : 'Which database?',
    header: multiSelect ? 'Features' : 'Database',
    multiSelect,
    options: Array.from({ length: n }, (_, i) => ({
      label: `Option ${i + 1}`,
      description: `Description ${i + 1}`,
      ...(withPreview ? { preview: `preview ${i + 1}` } : {}),
    })),
  };
}

function a(selected: number[], other: string | null = null): QuestionAnswer {
  return { selected, other };
}

describe('buildAnswerKeys', () => {
  it('single select second option', () => {
    // Lone single-select question: the digit answers and submits at once, no review screen.
    expect(buildAnswerKeys([q(false)], [a([1])])).toEqual(['2']);
  });

  it('other answer types text and submits', () => {
    // Digit 4 (options.length + 1) focuses the empty "Type something." row,
    // then the text, then Enter submits it.
    expect(buildAnswerKeys([q(false)], [a([], 'use redis')])).toEqual(['4', 'use redis', ENTER]);
  });

  it('other text newlines become spaces', () => {
    expect(buildAnswerKeys([q(false)], [a([], 'a\nb')])).toEqual(['4', 'a b', ENTER]);
    expect(buildAnswerKeys([q(false)], [a([], 'a\r\nb\tc')])).toEqual(['4', 'a b c', ENTER]);
  });

  it('other text strips escape and control characters', () => {
    expect(buildAnswerKeys([q(false)], [a([], 'x\x1by\x07z')])).toEqual(['4', 'xyz', ENTER]);
  });

  it('no key group mixes Enter with typed text', () => {
    const keys = buildAnswerKeys([q(false), q(true)], [a([], 'first\nline'), a([0], 'more')]);
    for (const k of keys) {
      if (k.includes('\r')) expect(k).toBe(ENTER);
    }
  });

  it('multi select toggles each chosen option then advances', () => {
    // Digits toggle without moving focus (focus stays on row 1). Down x (3 options + Other row)
    // reaches the Next/Submit button, Enter presses it, then Enter confirms "Submit answers".
    expect(buildAnswerKeys([q(true)], [a([2, 0])])).toEqual(['1', '3', DOWN, DOWN, DOWN, DOWN, ENTER, ENTER]);
  });

  it('multi select with other text types into the Other row then moves to submit', () => {
    expect(buildAnswerKeys([q(true)], [a([1], 'extra')])).toEqual([
      '2',
      DOWN,
      DOWN,
      DOWN,
      'extra',
      DOWN,
      ENTER,
      ENTER,
    ]);
  });

  it('two questions produce one key group per question plus the final confirm', () => {
    expect(buildAnswerKeys([q(false), q(true)], [a([0]), a([1, 2])])).toEqual([
      '1',
      '2',
      '3',
      DOWN,
      DOWN,
      DOWN,
      DOWN,
      ENTER,
      ENTER,
    ]);
  });

  it('two single-select questions end with the review confirm', () => {
    expect(buildAnswerKeys([q(false), q(false)], [a([2]), a([0])])).toEqual(['3', '1', ENTER]);
  });

  it('preview question focuses with a digit and selects with Enter', () => {
    expect(buildAnswerKeys([q(false, 3, true)], [a([1])])).toEqual(['2', ENTER]);
  });

  it('preview question rejects an Other answer (no Other row in that layout)', () => {
    expect(() => buildAnswerKeys([q(false, 3, true)], [a([], 'x')])).toThrow();
  });

  it('answers length mismatch throws', () => {
    expect(() => buildAnswerKeys([q(false), q(false)], [a([0])])).toThrow();
  });

  it('single select needs exactly one of a selected option or Other text', () => {
    expect(() => buildAnswerKeys([q(false)], [a([])])).toThrow();
    expect(() => buildAnswerKeys([q(false)], [a([0, 1])])).toThrow();
    expect(() => buildAnswerKeys([q(false)], [a([0], 'x')])).toThrow();
  });

  it('out of range option index throws', () => {
    expect(() => buildAnswerKeys([q(false)], [a([3])])).toThrow();
    expect(() => buildAnswerKeys([q(true)], [a([-1])])).toThrow();
  });

  it('blank Other text throws', () => {
    expect(() => buildAnswerKeys([q(false)], [a([], ' \n ')])).toThrow();
  });

  it('duplicate multi select indexes toggle once', () => {
    expect(buildAnswerKeys([q(true, 2)], [a([0, 0])])).toEqual(['1', DOWN, DOWN, DOWN, ENTER, ENTER]);
  });
});
