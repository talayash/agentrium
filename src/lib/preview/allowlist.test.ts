import { describe, expect, it } from 'vitest';
import { isUrlAllowed } from './allowlist';

describe('isUrlAllowed', () => {
  it('always allows localhost variants', () => {
    expect(isUrlAllowed('http://localhost:5173', [])).toBe(true);
    expect(isUrlAllowed('http://127.0.0.1:3000', [])).toBe(true);
    expect(isUrlAllowed('http://0.0.0.0:4321/', [])).toBe(true);
    expect(isUrlAllowed('https://localhost:8443', [])).toBe(true);
  });

  it('rejects arbitrary hostnames without allow-list entry', () => {
    expect(isUrlAllowed('http://evil.com', [])).toBe(false);
    expect(isUrlAllowed('https://example.org', [])).toBe(false);
  });

  it('allows hostnames matching allow-list glob', () => {
    expect(isUrlAllowed('https://abc.ngrok.io', ['*.ngrok.io'])).toBe(true);
    expect(isUrlAllowed('https://abc.def.ngrok.io', ['*.ngrok.io'])).toBe(false); // one label only
    expect(isUrlAllowed('https://foo.trycloudflare.com', ['*.trycloudflare.com'])).toBe(true);
  });

  it('rejects hostname-boundary tricks', () => {
    // '*.ngrok.io' must NOT match 'ngrok.io.evil.com'
    expect(isUrlAllowed('https://ngrok.io.evil.com', ['*.ngrok.io'])).toBe(false);
    expect(isUrlAllowed('https://evilngrok.io', ['*.ngrok.io'])).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(isUrlAllowed('not-a-url', [])).toBe(false);
    expect(isUrlAllowed('', [])).toBe(false);
    expect(isUrlAllowed('javascript:alert(1)', [])).toBe(false);
    expect(isUrlAllowed('file:///etc/passwd', [])).toBe(false);
  });

  it('only accepts http/https schemes', () => {
    expect(isUrlAllowed('ftp://localhost', [])).toBe(false);
    expect(isUrlAllowed('data:text/html,<h1>x</h1>', [])).toBe(false);
  });
});
