import { describe, expect, it, vi, beforeEach } from 'vitest';

// A fake OS clipboard whose writes take a tick to land, so an unserialized
// read would observe the *previous* value - the actual race this covers.
let osClipboard = '';
let writeDelayMs = 0;
const order: string[] = [];

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  writeText: vi.fn(async (text: string) => {
    order.push('write:start');
    if (writeDelayMs) await new Promise((r) => setTimeout(r, writeDelayMs));
    osClipboard = text;
    order.push('write:end');
  }),
  readText: vi.fn(async () => {
    order.push('read');
    return osClipboard;
  }),
}));

vi.mock('./errorReporter', () => ({ reportError: vi.fn() }));

const { copyText, readClipboardText } = await import('./clipboard');

beforeEach(() => {
  osClipboard = '';
  writeDelayMs = 0;
  order.length = 0;
});

describe('clipboard ordering', () => {
  it('a read issued during an in-flight copy observes the copied text', async () => {
    writeDelayMs = 20;
    // Deliberately NOT awaited - this is the Ctrl+C then immediate Ctrl+V case.
    const copying = copyText('fresh');
    const read = await readClipboardText();
    await copying;
    expect(read).toBe('fresh');
  });

  it('runs the read only after the write has settled', async () => {
    writeDelayMs = 20;
    const copying = copyText('fresh');
    await readClipboardText();
    await copying;
    expect(order).toEqual(['write:start', 'write:end', 'read']);
  });

  it('keeps multiple queued copies in call order', async () => {
    writeDelayMs = 10;
    const a = copyText('first');
    const b = copyText('second');
    await Promise.all([a, b]);
    expect(osClipboard).toBe('second');
  });

  it('a failed copy does not wedge the queue for later operations', async () => {
    const mod = await import('@tauri-apps/plugin-clipboard-manager');
    vi.mocked(mod.writeText).mockRejectedValueOnce(new Error('nope'));
    // Falls back through the web paths, all absent under jsdom, so it reports
    // false - but the queue must keep draining.
    await copyText('doomed');
    osClipboard = 'set-directly';
    await expect(readClipboardText()).resolves.toBe('set-directly');
  });

  it('still returns true when the native write succeeds', async () => {
    await expect(copyText('ok')).resolves.toBe(true);
    expect(osClipboard).toBe('ok');
  });
});
