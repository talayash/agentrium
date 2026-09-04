import { describe, expect, it } from 'vitest';
import { classifyPasteInput } from './pasteWarning';

const defaults = {
  autoDetectEnabled: true,
  thresholdBytes: 1024,
  thresholdLines: 10,
};

describe('classifyPasteInput', () => {
  it('forwards short interactive typing without warning', () => {
    const v = classifyPasteInput({
      data: 'a',
      msSinceLastInput: 5,
      ...defaults,
    });
    expect(v.action).toBe('forward');
  });

  it('forwards even a long blob if the user is actively typing (short gap)', () => {
    const v = classifyPasteInput({
      data: 'x'.repeat(2000),
      msSinceLastInput: 8,
      ...defaults,
    });
    expect(v.action).toBe('forward');
  });

  it('treats the very first input event as a potential paste (no prior timestamp)', () => {
    const v = classifyPasteInput({
      data: 'x'.repeat(2000),
      msSinceLastInput: Number.POSITIVE_INFINITY,
      ...defaults,
    });
    expect(v.action).toBe('warn');
  });

  it('warns when a large paste arrives after a pause and exceeds byte threshold', () => {
    const v = classifyPasteInput({
      data: 'x'.repeat(2000),
      msSinceLastInput: 500,
      ...defaults,
    });
    expect(v.action).toBe('warn');
    expect(v.bytes).toBe(2000);
  });

  it('warns when a paste exceeds line threshold even if under byte threshold', () => {
    const data = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n');
    const v = classifyPasteInput({
      data,
      msSinceLastInput: 500,
      autoDetectEnabled: true,
      thresholdBytes: 1_000_000,
      thresholdLines: 10,
    });
    expect(v.action).toBe('warn');
    expect(v.lines).toBe(50);
  });

  it('forwards when auto-detect is disabled, no matter how large the paste', () => {
    const v = classifyPasteInput({
      data: 'x'.repeat(1_000_000),
      msSinceLastInput: Number.POSITIVE_INFINITY,
      autoDetectEnabled: false,
      thresholdBytes: 1024,
      thresholdLines: 10,
    });
    expect(v.action).toBe('forward');
  });

  it('forwards a paste below both byte and line thresholds', () => {
    const v = classifyPasteInput({
      data: 'x'.repeat(100),
      msSinceLastInput: 500,
      ...defaults,
    });
    expect(v.action).toBe('forward');
  });

  it('respects the 64-byte fast-path - smaller than that is never a paste', () => {
    const v = classifyPasteInput({
      data: 'x'.repeat(64),
      msSinceLastInput: 500,
      ...defaults,
    });
    expect(v.action).toBe('forward');
  });

  it('counts multi-byte UTF-8 bytes correctly for the byte threshold', () => {
    // "€" is 3 bytes in UTF-8. 400 copies = 1200 bytes, above the 1024 threshold.
    const v = classifyPasteInput({
      data: '€'.repeat(400),
      msSinceLastInput: 500,
      ...defaults,
    });
    expect(v.action).toBe('warn');
    expect(v.bytes).toBe(1200);
  });
});
