import { describe, it, expect } from 'vitest';
import { pathToFileUri, pathKey } from './paths';

describe('pathToFileUri', () => {
  it('converts a Windows path', () => {
    expect(pathToFileUri('C:\\Users\\tal\\app\\a.ts')).toBe('file:///C:/Users/tal/app/a.ts');
  });
  it('encodes spaces', () => {
    expect(pathToFileUri('C:\\my repo\\a.ts')).toBe('file:///C:/my%20repo/a.ts');
  });
  it('passes unix paths through', () => {
    expect(pathToFileUri('/home/tal/a.rs')).toBe('file:///home/tal/a.rs');
  });
});

describe('pathKey', () => {
  it('normalizes a raw Windows path', () => {
    expect(pathKey('C:\\Users\\Tal\\a.ts')).toBe('c:/users/tal/a.ts');
  });
  it('normalizes a file URI with encoded drive colon', () => {
    expect(pathKey('file:///c%3A/Users/Tal/a.ts')).toBe('c:/users/tal/a.ts');
  });
  it('normalizes a plain file URI', () => {
    expect(pathKey('file:///C:/Users/Tal/my%20repo/a.ts')).toBe('c:/users/tal/my repo/a.ts');
  });
  it('matches raw path against its own URI', () => {
    expect(pathKey('C:\\x\\y.py')).toBe(pathKey(pathToFileUri('C:\\x\\y.py')));
  });
  it('decodes percent-encoded percent signs', () => {
    expect(pathKey('file:///C:/dev/100%25done/a.ts')).toBe('c:/dev/100%done/a.ts');
  });
  it('decodes a Monaco URI parsed from a raw Windows path (encoded backslashes, no file://)', () => {
    // monaco.Uri.parse('C:\\Users\\tal\\a.ts').toString() === 'C:%5CUsers%5Ctal%5Ca.ts'
    expect(pathKey('C:%5CUsers%5Ctal%5Ca.ts')).toBe(pathKey('C:\\Users\\tal\\a.ts'));
  });
});
