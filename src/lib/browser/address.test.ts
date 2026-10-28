import { describe, it, expect } from 'vitest';
import { resolveAddress, hostOf, isSecure, SEARCH_URL } from './address';

describe('resolveAddress', () => {
  it('returns null for empty input', () => {
    expect(resolveAddress('')).toBeNull();
    expect(resolveAddress('   ')).toBeNull();
  });

  it('keeps full http(s) URLs', () => {
    expect(resolveAddress('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(resolveAddress('  http://example.com ')).toBe('http://example.com');
  });

  it('adds https to bare domains', () => {
    expect(resolveAddress('example.com')).toBe('https://example.com');
    expect(resolveAddress('docs.example.co.uk/path#x')).toBe('https://docs.example.co.uk/path#x');
    expect(resolveAddress('example.com:8443')).toBe('https://example.com:8443');
  });

  it('adds http to localhost and IPs', () => {
    expect(resolveAddress('localhost:3000')).toBe('http://localhost:3000');
    expect(resolveAddress('localhost')).toBe('http://localhost');
    expect(resolveAddress('127.0.0.1:5173/app')).toBe('http://127.0.0.1:5173/app');
    expect(resolveAddress('192.168.1.10')).toBe('http://192.168.1.10');
  });

  it('turns other text into a search', () => {
    expect(resolveAddress('how to center a div')).toBe(SEARCH_URL + 'how%20to%20center%20a%20div');
    expect(resolveAddress('react')).toBe(SEARCH_URL + 'react');
    expect(resolveAddress('1.5')).toBe(SEARCH_URL + '1.5');
    expect(resolveAddress('example.com is down')).toBe(SEARCH_URL + 'example.com%20is%20down');
  });

  it('passes other schemes through for the backend to reject', () => {
    expect(resolveAddress('file:///C:/x')).toBe('file:///C:/x');
    expect(resolveAddress('agentrium://auth-return')).toBe('agentrium://auth-return');
  });
});

describe('hostOf / isSecure', () => {
  it('extracts the host and falls back to the input', () => {
    expect(hostOf('https://example.com:8080/a')).toBe('example.com:8080');
    expect(hostOf('not a url')).toBe('not a url');
  });

  it('detects https', () => {
    expect(isSecure('https://example.com')).toBe(true);
    expect(isSecure('http://localhost:3000')).toBe(false);
  });
});
