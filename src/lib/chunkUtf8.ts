/**
 * Split a UTF-8 byte buffer into chunks no larger than `max`, preferring to
 * cut on a code-point boundary so a receiving decoder never sees a partial
 * sequence mid-chunk. Used to chunk large terminal pastes under the PTY's
 * per-write size limit.
 *
 * If a chunk boundary lands inside a multi-byte sequence, walks backward to
 * the start of that sequence. For degenerate input (all continuation bytes),
 * falls back to a hard cut so we never loop or stall.
 */
export function chunkUtf8Bytes(bytes: Uint8Array, max: number): Uint8Array[] {
  if (max < 4) throw new Error('chunkUtf8Bytes: max must be >= 4 (UTF-8 max code point)');
  if (bytes.length <= max) return [bytes];

  const chunks: Uint8Array[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + max, bytes.length);
    // If `end` points to a continuation byte (10xxxxxx), it's mid-sequence -
    // walk back to the start of that sequence so the chunk ends cleanly.
    if (end < bytes.length) {
      let probe = end;
      while (probe > start && (bytes[probe] & 0xc0) === 0x80) {
        probe--;
      }
      if (probe > start) end = probe;
    }
    chunks.push(bytes.subarray(start, end));
    start = end;
  }
  return chunks;
}
