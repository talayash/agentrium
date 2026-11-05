import { describe, expect, it } from 'vitest';
import { detectStructured } from './structuredOutput';

describe('detectStructured', () => {
  it('detects markdown table', () => {
    const text = 'Intro\n\n| Name | Count |\n| --- | --- |\n| a | 1 |\n| b | 2 |\n\nOutro';
    const blocks = detectStructured(text);
    expect(blocks.map((b) => b.kind)).toEqual(['markdown', 'table', 'markdown']);
    expect(blocks[1]).toEqual({
      kind: 'table',
      headers: ['Name', 'Count'],
      rows: [
        ['a', '1'],
        ['b', '2'],
      ],
    });
  });

  it('pipe text without separator stays markdown', () => {
    const blocks = detectStructured('a | b | c\nd | e | f');
    expect(blocks).toEqual([{ kind: 'markdown', text: 'a | b | c\nd | e | f' }]);
  });

  it('json array of objects becomes table', () => {
    const text = '```json\n[{"a":1,"b":"x"},{"a":2,"b":"y"}]\n```';
    const blocks = detectStructured(text);
    expect(blocks).toEqual([
      { kind: 'table', headers: ['a', 'b'], rows: [['1', 'x'], ['2', 'y']] },
    ]);
  });

  it('json numbers object becomes bars', () => {
    const blocks = detectStructured('```json\n{"x": 3, "y": 5}\n```');
    expect(blocks).toEqual([
      { kind: 'bars', items: [{ label: 'x', value: 3 }, { label: 'y', value: 5 }] },
    ]);
  });

  it('json number series becomes line', () => {
    const blocks = detectStructured('```json\n[1,2,3,4,5,6]\n```');
    expect(blocks).toEqual([{ kind: 'line', points: [1, 2, 3, 4, 5, 6] }]);
    const bars = detectStructured('```json\n[1,2,3]\n```');
    expect(bars).toEqual([
      { kind: 'bars', items: [{ label: '1', value: 1 }, { label: '2', value: 2 }, { label: '3', value: 3 }] },
    ]);
  });

  it('invalid json stays markdown', () => {
    const text = '```json\n{not json\n```';
    const blocks = detectStructured(text);
    expect(blocks).toEqual([{ kind: 'markdown', text }]);
  });

  it('label: number list becomes bars', () => {
    const blocks = detectStructured('- alpha: 10\n- beta: 20.5%\n* gamma: -3');
    expect(blocks).toEqual([
      {
        kind: 'bars',
        items: [
          { label: 'alpha', value: 10 },
          { label: 'beta', value: 20.5 },
          { label: 'gamma', value: -3 },
        ],
      },
    ]);
  });

  it('two label: number lines stay markdown', () => {
    expect(detectStructured('- a: 1\n- b: 2')[0].kind).toBe('markdown');
  });

  it('keeps document order of mixed blocks', () => {
    const text = 'Top\n\n- a: 1\n- b: 2\n- c: 3\n\nMiddle\n\n| h1 | h2 |\n|---|---|\n| x | y |\n\nEnd';
    expect(detectStructured(text).map((b) => b.kind)).toEqual([
      'markdown', 'bars', 'markdown', 'table', 'markdown',
    ]);
  });

  it('caps bars at 20 items', () => {
    const text = Array.from({ length: 30 }, (_, i) => `- k${i}: ${i}`).join('\n');
    const b = detectStructured(text)[0];
    expect(b.kind === 'bars' && b.items.length).toBe(20);
  });
});
