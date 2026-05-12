import { describe, it, expect } from 'vitest';
import { parseDiff } from './diffParser';

describe('parseDiff', () => {
  it('returns empty array for empty input', () => {
    expect(parseDiff('')).toEqual([]);
  });

  it('returns empty array when there are no hunk headers', () => {
    const diff = [
      'diff --git a/foo.ts b/foo.ts',
      'index 0000..1111',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      'some stray text that should be ignored',
    ].join('\n');
    expect(parseDiff(diff)).toEqual([]);
  });

  it('parses a single hunk with added, removed, and context lines', () => {
    const diff = [
      '@@ -1,3 +1,3 @@ function foo()',
      ' context-line',
      '-old-line',
      '+new-line',
      ' tail-line',
    ].join('\n');

    const hunks = parseDiff(diff);

    expect(hunks).toHaveLength(1);
    expect(hunks[0].header).toBe('@@ -1,3 +1,3 @@ function foo()');
    expect(hunks[0].lines).toEqual([
      { type: 'context', content: 'context-line', oldLineNumber: 1, newLineNumber: 1 },
      { type: 'removed', content: 'old-line', oldLineNumber: 2, newLineNumber: null },
      { type: 'added', content: 'new-line', oldLineNumber: null, newLineNumber: 2 },
      { type: 'context', content: 'tail-line', oldLineNumber: 3, newLineNumber: 3 },
    ]);
  });

  it('increments old/new line numbers independently across removed/added/context', () => {
    const diff = [
      '@@ -10,4 +20,4 @@',
      ' a',
      '-b',
      '-c',
      '+B',
      '+C',
      ' d',
    ].join('\n');

    const lines = parseDiff(diff)[0].lines;

    expect(lines.map((l) => [l.type, l.oldLineNumber, l.newLineNumber])).toEqual([
      ['context', 10, 20],
      ['removed', 11, null],
      ['removed', 12, null],
      ['added', null, 21],
      ['added', null, 22],
      ['context', 13, 23],
    ]);
  });

  it('accepts hunk headers without line counts (e.g. "@@ -1 +1 @@")', () => {
    const diff = ['@@ -7 +9 @@', ' only-line'].join('\n');
    const hunks = parseDiff(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines[0]).toEqual({
      type: 'context',
      content: 'only-line',
      oldLineNumber: 7,
      newLineNumber: 9,
    });
  });

  it('strips CRLF line endings', () => {
    const diff = '@@ -1,1 +1,1 @@\r\n+hello\r\n';
    const hunks = parseDiff(diff);
    expect(hunks[0].lines[0].content).toBe('hello');
  });

  it('skips "\\ No newline at end of file" markers', () => {
    const diff = [
      '@@ -1,2 +1,2 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
    ].join('\n');

    const hunks = parseDiff(diff);
    expect(hunks[0].lines).toEqual([
      { type: 'removed', content: 'old', oldLineNumber: 1, newLineNumber: null },
      { type: 'added', content: 'new', oldLineNumber: null, newLineNumber: 1 },
    ]);
  });

  it('parses multiple hunks in one diff', () => {
    const diff = [
      'diff --git a/foo.ts b/foo.ts',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+A',
      '@@ -10,1 +10,1 @@',
      '-b',
      '+B',
    ].join('\n');

    const hunks = parseDiff(diff);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].header).toBe('@@ -1,1 +1,1 @@');
    expect(hunks[1].header).toBe('@@ -10,1 +10,1 @@');
    expect(hunks[1].lines[0]).toEqual({
      type: 'removed',
      content: 'b',
      oldLineNumber: 10,
      newLineNumber: null,
    });
  });

  it('drops content lines that appear before the first hunk header', () => {
    const diff = [
      '+orphan-add',
      '-orphan-remove',
      '@@ -1,1 +1,1 @@',
      '+real-add',
    ].join('\n');

    const hunks = parseDiff(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines).toEqual([
      { type: 'added', content: 'real-add', oldLineNumber: null, newLineNumber: 1 },
    ]);
  });

  it('treats fully blank lines as context', () => {
    const diff = ['@@ -1,3 +1,3 @@', ' a', '', ' c'].join('\n');
    const lines = parseDiff(diff)[0].lines;
    expect(lines).toEqual([
      { type: 'context', content: 'a', oldLineNumber: 1, newLineNumber: 1 },
      { type: 'context', content: '', oldLineNumber: 2, newLineNumber: 2 },
      { type: 'context', content: 'c', oldLineNumber: 3, newLineNumber: 3 },
    ]);
  });

  it('preserves an empty content for an added blank line', () => {
    const diff = ['@@ -1,1 +1,2 @@', ' a', '+'].join('\n');
    const lines = parseDiff(diff)[0].lines;
    expect(lines[1]).toEqual({
      type: 'added',
      content: '',
      oldLineNumber: null,
      newLineNumber: 2,
    });
  });

  it('ignores rename and similarity metadata', () => {
    const diff = [
      'diff --git a/old.ts b/new.ts',
      'similarity index 80%',
      'rename from old.ts',
      'rename to new.ts',
      '@@ -1,1 +1,1 @@',
      '-x',
      '+y',
    ].join('\n');

    const hunks = parseDiff(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines).toHaveLength(2);
  });
});
