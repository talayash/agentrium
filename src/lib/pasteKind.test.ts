import { describe, expect, it } from 'vitest';
import { detectKindClient, kindToExt } from './pasteKind';

describe('detectKindClient', () => {
  it('detects valid JSON objects and arrays', () => {
    expect(detectKindClient('{"a": 1}')).toBe('json');
    expect(detectKindClient('  [1, 2, 3]')).toBe('json');
  });

  it('does not treat brace-leading-but-invalid JSON as json', () => {
    expect(detectKindClient('{ not json at all')).toBe('text');
  });

  it('detects XML-ish content', () => {
    expect(detectKindClient('<root><child/></root>')).toBe('xml');
  });

  it('detects logs when enough lines carry level markers', () => {
    const log = [
      '[INFO] starting up',
      '[WARN] low memory',
      '[ERROR] boom',
      '[DEBUG] details',
      '[INFO] done',
    ].join('\n');
    expect(detectKindClient(log)).toBe('log');
  });

  it('falls back to text for plain prose', () => {
    expect(detectKindClient('just a normal sentence or two')).toBe('text');
  });
});

describe('kindToExt', () => {
  it('maps text to txt and passes others through', () => {
    expect(kindToExt('text')).toBe('txt');
    expect(kindToExt('json')).toBe('json');
    expect(kindToExt('log')).toBe('log');
    expect(kindToExt('xml')).toBe('xml');
  });
});
