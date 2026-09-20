import { describe, it, expect } from 'vitest';
import {
  normalizeFeedback,
  hashIP,
  ipHashSalt,
  NAME_MAX,
  MESSAGE_MAX,
  parseDeleteBody,
  DELETE_MAX_IDS,
  type RawFeedback,
} from './feedback';

describe('normalizeFeedback', () => {
  const ok: RawFeedback = {
    name: 'Tal',
    message: 'Hi there',
    honeypot: '',
    app_version: '1.33.4',
    os: 'windows',
  };

  it('accepts a normal submission', () => {
    const r = normalizeFeedback(ok);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        name: 'Tal',
        message: 'Hi there',
        app_version: '1.33.4',
        os: 'windows',
      });
    }
  });

  it('trims whitespace from name and message', () => {
    const r = normalizeFeedback({ ...ok, name: '  Tal  ', message: '\n Hi \t' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe('Tal');
      expect(r.value.message).toBe('Hi');
    }
  });

  it('rejects a filled honeypot as spam (even when other fields are valid)', () => {
    const r = normalizeFeedback({ ...ok, honeypot: 'http://spam.example' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('spam');
  });

  it('rejects a missing or non-string name as invalid', () => {
    expect(normalizeFeedback({ ...ok, name: undefined }).ok).toBe(false);
    expect(normalizeFeedback({ ...ok, name: 42 }).ok).toBe(false);
    expect(normalizeFeedback({ ...ok, name: '' }).ok).toBe(false);
    expect(normalizeFeedback({ ...ok, name: '   ' }).ok).toBe(false);
  });

  it(`rejects a name longer than ${NAME_MAX} chars`, () => {
    const r = normalizeFeedback({ ...ok, name: 'x'.repeat(NAME_MAX + 1) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid');
  });

  it(`accepts a name of exactly ${NAME_MAX} chars`, () => {
    const r = normalizeFeedback({ ...ok, name: 'x'.repeat(NAME_MAX) });
    expect(r.ok).toBe(true);
  });

  it('rejects a missing or non-string message as invalid', () => {
    expect(normalizeFeedback({ ...ok, message: undefined }).ok).toBe(false);
    expect(normalizeFeedback({ ...ok, message: 42 }).ok).toBe(false);
    expect(normalizeFeedback({ ...ok, message: '' }).ok).toBe(false);
    expect(normalizeFeedback({ ...ok, message: '  \n\t' }).ok).toBe(false);
  });

  it(`rejects a message longer than ${MESSAGE_MAX} chars`, () => {
    const r = normalizeFeedback({ ...ok, message: 'x'.repeat(MESSAGE_MAX + 1) });
    expect(r.ok).toBe(false);
  });

  it('defaults missing app_version and os to "unknown"', () => {
    const r = normalizeFeedback({ name: 'Tal', message: 'Hi', honeypot: '' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.app_version).toBe('unknown');
      expect(r.value.os).toBe('unknown');
    }
  });

  it('caps app_version and os at conservative lengths', () => {
    const r = normalizeFeedback({
      ...ok,
      app_version: 'x'.repeat(100),
      os: 'y'.repeat(100),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Same caps we use for heartbeats: version ≤ 32, os ≤ 32.
      expect(r.value.app_version.length).toBeLessThanOrEqual(32);
      expect(r.value.os.length).toBeLessThanOrEqual(32);
    }
  });

  it('honeypot check runs before field validation (spam does not leak field hints)', () => {
    // Empty name + filled honeypot: caller must get 'spam', not 'invalid'.
    const r = normalizeFeedback({ name: '', message: '', honeypot: 'bot' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('spam');
  });
});

describe('hashIP', () => {
  it('produces a stable, non-empty hex string for the same input', async () => {
    const a = await hashIP('203.0.113.7', 'salt');
    const b = await hashIP('203.0.113.7', 'salt');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]+$/);
    expect(a.length).toBeGreaterThan(0);
  });

  it('produces different hashes for different IPs', async () => {
    const a = await hashIP('203.0.113.7', 'salt');
    const b = await hashIP('203.0.113.8', 'salt');
    expect(a).not.toBe(b);
  });

  it('produces different hashes for the same IP with different salts', async () => {
    const a = await hashIP('203.0.113.7', 'salt1');
    const b = await hashIP('203.0.113.7', 'salt2');
    expect(a).not.toBe(b);
  });

  it('never returns the raw IP', async () => {
    const ip = '203.0.113.7';
    const h = await hashIP(ip, 'salt');
    expect(h).not.toContain(ip);
    expect(h).not.toContain('203');
  });
});

describe('ipHashSalt', () => {
  it('prefers the dedicated IP_HASH_SALT secret over the stats token', () => {
    expect(ipHashSalt({ STATS_TOKEN: 'tok', IP_HASH_SALT: 'pepper' })).toBe('pepper');
  });

  it('falls back to STATS_TOKEN so existing buckets keep working until the secret is added', () => {
    expect(ipHashSalt({ STATS_TOKEN: 'tok' })).toBe('tok');
    expect(ipHashSalt({ STATS_TOKEN: 'tok', IP_HASH_SALT: '' })).toBe('tok');
  });

  it('degrades to the legacy unsalted marker when neither secret is set', () => {
    expect(ipHashSalt({})).toBe('unsalted');
  });
});

describe('parseDeleteBody', () => {
  it('accepts a delete request', () => {
    expect(parseDeleteBody({ ids: [1, 2], deleted: true })).toEqual({ ids: [1, 2], deleted: true });
  });

  it('accepts an undo request', () => {
    // Undo is the same endpoint with the flag flipped, which is why the
    // toast's Undo button needs no special server route.
    expect(parseDeleteBody({ ids: [3], deleted: false })).toEqual({ ids: [3], deleted: false });
  });

  it('defaults deleted to true when the flag is absent', () => {
    expect(parseDeleteBody({ ids: [1] })?.deleted).toBe(true);
  });

  it('accepts numeric strings, since JSON ids may arrive as text', () => {
    expect(parseDeleteBody({ ids: ['4', '5'] })?.ids).toEqual([4, 5]);
  });

  it('de-duplicates ids', () => {
    expect(parseDeleteBody({ ids: [7, 7, 8] })?.ids).toEqual([7, 8]);
  });

  it('rejects a non-object body', () => {
    expect(parseDeleteBody(null)).toBeNull();
    expect(parseDeleteBody(42)).toBeNull();
  });

  it('rejects a missing or non-array ids field', () => {
    expect(parseDeleteBody({})).toBeNull();
    expect(parseDeleteBody({ ids: 5 })).toBeNull();
  });

  it('rejects an empty id list', () => {
    expect(parseDeleteBody({ ids: [] })).toBeNull();
  });

  it('rejects a non-boolean deleted flag', () => {
    expect(parseDeleteBody({ ids: [1], deleted: 'yes' })).toBeNull();
  });

  it('rejects ids that are not positive integers', () => {
    // Strict, unlike mark_read: silently skipping a malformed id in a
    // destructive call would delete a different set than the caller asked for.
    expect(parseDeleteBody({ ids: [0] })).toBeNull();
    expect(parseDeleteBody({ ids: [-1] })).toBeNull();
    expect(parseDeleteBody({ ids: [1.5] })).toBeNull();
    expect(parseDeleteBody({ ids: ['abc'] })).toBeNull();
    expect(parseDeleteBody({ ids: [null] })).toBeNull();
  });

  it('rejects a batch larger than the D1 bound-parameter budget', () => {
    const many = Array.from({ length: DELETE_MAX_IDS + 1 }, (_, i) => i + 1);
    expect(parseDeleteBody({ ids: many })).toBeNull();
  });

  it('accepts a batch exactly at the cap', () => {
    const many = Array.from({ length: DELETE_MAX_IDS }, (_, i) => i + 1);
    expect(parseDeleteBody({ ids: many })?.ids).toHaveLength(DELETE_MAX_IDS);
  });
});
