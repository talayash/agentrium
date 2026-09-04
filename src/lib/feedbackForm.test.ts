import { describe, it, expect } from 'vitest';
import { validateFeedback, NAME_MAX, MESSAGE_MAX } from './feedbackForm';

describe('validateFeedback', () => {
  const ok = { name: 'Tal', message: 'Hi there', honeypot: '' };

  it('accepts a normal name + message', () => {
    const r = validateFeedback(ok);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ name: 'Tal', message: 'Hi there' });
    }
  });

  it('trims leading/trailing whitespace from name and message', () => {
    const r = validateFeedback({ name: '  Tal  ', message: '\n Hi \t', honeypot: '' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ name: 'Tal', message: 'Hi' });
    }
  });

  it('rejects a filled honeypot silently (as spam) even when other fields are valid', () => {
    const r = validateFeedback({ ...ok, honeypot: 'http://spam.example' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('Spam detected');
  });

  it('rejects an empty name', () => {
    const r = validateFeedback({ ...ok, name: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('Name is required');
  });

  it('rejects a whitespace-only name (post-trim)', () => {
    const r = validateFeedback({ ...ok, name: '   ' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('Name is required');
  });

  it(`rejects a name longer than ${NAME_MAX} characters`, () => {
    const r = validateFeedback({ ...ok, name: 'x'.repeat(NAME_MAX + 1) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(`Name must be ${NAME_MAX} characters or fewer`);
  });

  it(`accepts a name of exactly ${NAME_MAX} characters`, () => {
    const r = validateFeedback({ ...ok, name: 'x'.repeat(NAME_MAX) });
    expect(r.ok).toBe(true);
  });

  it('rejects an empty message', () => {
    const r = validateFeedback({ ...ok, message: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('Message is required');
  });

  it('rejects a whitespace-only message (post-trim)', () => {
    const r = validateFeedback({ ...ok, message: '   \n\t' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('Message is required');
  });

  it(`rejects a message longer than ${MESSAGE_MAX} characters`, () => {
    const r = validateFeedback({ ...ok, message: 'x'.repeat(MESSAGE_MAX + 1) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(`Message must be ${MESSAGE_MAX} characters or fewer`);
  });

  it('honeypot check runs before other validation (spam does not leak field hints)', () => {
    // Empty name + filled honeypot: caller must see 'Spam detected', not 'Name is required'.
    const r = validateFeedback({ name: '', message: '', honeypot: 'bot' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('Spam detected');
  });
});
