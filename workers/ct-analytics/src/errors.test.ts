import { describe, it, expect } from 'vitest';
import {
  parseResolveBody,
  isGroupResolved,
  FINGERPRINT_MAX,
  RESOLVE_MAX_FINGERPRINTS,
} from './errors';

describe('parseResolveBody', () => {
  it('accepts a resolve request', () => {
    const r = parseResolveBody({ fingerprints: ['abc123'], resolved: true });
    expect(r).toEqual({ fingerprints: ['abc123'], resolved: true });
  });

  it('accepts an un-resolve request', () => {
    const r = parseResolveBody({ fingerprints: ['abc123'], resolved: false });
    expect(r).toEqual({ fingerprints: ['abc123'], resolved: false });
  });

  it('defaults resolved to true when the flag is absent', () => {
    // The dashboard's common action is resolving, so an omitted flag must not
    // silently un-resolve a group.
    expect(parseResolveBody({ fingerprints: ['abc123'] })?.resolved).toBe(true);
  });

  it('de-duplicates fingerprints', () => {
    const r = parseResolveBody({ fingerprints: ['a', 'b', 'a'], resolved: true });
    expect(r?.fingerprints).toEqual(['a', 'b']);
  });

  it('rejects a non-object body', () => {
    expect(parseResolveBody(null)).toBeNull();
    expect(parseResolveBody('abc')).toBeNull();
  });

  it('rejects a missing or non-array fingerprints field', () => {
    expect(parseResolveBody({})).toBeNull();
    expect(parseResolveBody({ fingerprints: 'abc' })).toBeNull();
  });

  it('rejects an empty fingerprint list', () => {
    // An empty batch is a client bug, not a no-op worth a 200.
    expect(parseResolveBody({ fingerprints: [] })).toBeNull();
  });

  it('rejects a non-boolean resolved flag', () => {
    expect(parseResolveBody({ fingerprints: ['a'], resolved: 'yes' })).toBeNull();
  });

  it('rejects a non-string fingerprint', () => {
    expect(parseResolveBody({ fingerprints: ['a', 7] })).toBeNull();
  });

  it('rejects an empty-string fingerprint', () => {
    expect(parseResolveBody({ fingerprints: [''] })).toBeNull();
  });

  it('rejects a fingerprint longer than the ingest clamp', () => {
    // /error_report clamps fingerprint to FINGERPRINT_MAX, so anything longer
    // cannot match a stored row and is a malformed request.
    expect(parseResolveBody({ fingerprints: ['x'.repeat(FINGERPRINT_MAX + 1)] })).toBeNull();
  });

  it('accepts a fingerprint exactly at the clamp length', () => {
    const fp = 'x'.repeat(FINGERPRINT_MAX);
    expect(parseResolveBody({ fingerprints: [fp] })?.fingerprints).toEqual([fp]);
  });

  it('rejects a batch larger than the cap', () => {
    const many = Array.from({ length: RESOLVE_MAX_FINGERPRINTS + 1 }, (_, i) => `fp${i}`);
    expect(parseResolveBody({ fingerprints: many })).toBeNull();
  });
});

describe('isGroupResolved', () => {
  it('is false when the group was never resolved', () => {
    expect(isGroupResolved('2026-09-18T10:00:00.000Z', null)).toBe(false);
  });

  it('is true when no occurrence followed the resolve', () => {
    expect(isGroupResolved('2026-09-18T10:00:00.000Z', '2026-09-18T11:00:00.000Z')).toBe(true);
  });

  it('reopens when the error happened again after the resolve', () => {
    // The whole point of resolve-with-auto-reopen: a fix that did not work
    // must put the group back on the badge without any manual step.
    expect(isGroupResolved('2026-09-18T12:00:00.000Z', '2026-09-18T11:00:00.000Z')).toBe(false);
  });

  it('stays resolved for an occurrence at the exact resolve instant', () => {
    const t = '2026-09-18T11:00:00.000Z';
    expect(isGroupResolved(t, t)).toBe(true);
  });

  it('compares SQLite datetime() text against ISO timestamps correctly', () => {
    // errors.ts is written as toISOString() but aggregate reads can surface
    // SQLite's "YYYY-MM-DD HH:MM:SS" shape, which Date.parse reads as local
    // time unless it is normalised to UTC first.
    expect(isGroupResolved('2026-09-18 12:00:00', '2026-09-18T11:00:00.000Z')).toBe(false);
    expect(isGroupResolved('2026-09-18 10:00:00', '2026-09-18T11:00:00.000Z')).toBe(true);
  });

  it('is false when the last-seen timestamp is missing', () => {
    expect(isGroupResolved(null, '2026-09-18T11:00:00.000Z')).toBe(false);
  });

  it('is false when either timestamp is unparsable', () => {
    expect(isGroupResolved('not-a-date', '2026-09-18T11:00:00.000Z')).toBe(false);
    expect(isGroupResolved('2026-09-18T10:00:00.000Z', 'not-a-date')).toBe(false);
  });
});
