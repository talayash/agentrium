import { describe, expect, it } from 'vitest';
import { chunkUtf8Bytes } from './chunkUtf8';

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function decode(b: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(b);
}

describe('chunkUtf8Bytes', () => {
  it('returns the buffer unchanged when it fits in one chunk', () => {
    const bytes = encode('hello');
    const out = chunkUtf8Bytes(bytes, 16);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(bytes);
  });

  it('splits ASCII into chunks no larger than max', () => {
    const bytes = encode('abcdefghijklmnopqrstuvwxyz');
    const out = chunkUtf8Bytes(bytes, 10);
    expect(out).toHaveLength(3);
    expect(out.every((c) => c.length <= 10)).toBe(true);
    // Reassembly is lossless.
    const total = new Uint8Array(bytes.length);
    let off = 0;
    for (const c of out) {
      total.set(c, off);
      off += c.length;
    }
    expect(Array.from(total)).toEqual(Array.from(bytes));
  });

  it('does NOT split a multi-byte UTF-8 sequence', () => {
    // '😀' is U+1F600, encoded as 4 bytes (F0 9F 98 80). Surround with ASCII
    // so the natural cut point lands inside the emoji.
    const s = 'AAA' + '😀' + 'BBB';
    const bytes = encode(s);
    // max=5 forces the cut at offset 5; that's at the second emoji byte.
    const out = chunkUtf8Bytes(bytes, 5);
    // Each chunk must independently decode without error.
    for (const c of out) {
      expect(() => decode(c)).not.toThrow();
    }
    // Reassembled string matches the original.
    const reassembled = out.map(decode).join('');
    expect(reassembled).toBe(s);
  });

  it('handles a buffer that is exactly `max` bytes', () => {
    const bytes = encode('1234567890');
    const out = chunkUtf8Bytes(bytes, 10);
    expect(out).toHaveLength(1);
  });

  it('handles a buffer just over `max` bytes', () => {
    const bytes = encode('12345678901'); // 11 bytes, max=10
    const out = chunkUtf8Bytes(bytes, 10);
    expect(out.map((c) => c.length)).toEqual([10, 1]);
  });

  it('falls back to a hard cut on degenerate all-continuation input', () => {
    // Pure continuation bytes (invalid UTF-8). We must still terminate.
    const bytes = new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80]);
    const out = chunkUtf8Bytes(bytes, 4);
    expect(out.length).toBeGreaterThan(0);
    expect(out.reduce((n, c) => n + c.length, 0)).toBe(bytes.length);
  });

  it('rejects a max smaller than the longest UTF-8 sequence (4)', () => {
    expect(() => chunkUtf8Bytes(encode('hi'), 3)).toThrow();
  });

  it('chunks a 200 KB ASCII paste into 64 KB pieces correctly', () => {
    const bytes = new Uint8Array(200 * 1024);
    bytes.fill(0x41); // 'A'
    const max = 60 * 1024;
    const out = chunkUtf8Bytes(bytes, max);
    expect(out.length).toBe(Math.ceil(bytes.length / max));
    expect(out.every((c) => c.length <= max)).toBe(true);
    expect(out.reduce((n, c) => n + c.length, 0)).toBe(bytes.length);
  });
});
