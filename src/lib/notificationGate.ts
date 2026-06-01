function toMinutes(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/**
 * True if `now` falls inside the Do-Not-Disturb window [start, end).
 * Supports same-day (start < end) and overnight (start > end) windows.
 * A zero-length or malformed window is treated as disabled (false).
 */
export function isWithinDnd(start: string, end: string, now: Date): boolean {
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s === null || e === null || s === e) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}

/**
 * Best-effort short beep for users who enable notification sound. Uses a brief
 * Web Audio oscillator so we don't ship an audio asset. Silently no-ops if the
 * AudioContext is unavailable or blocked.
 */
export function playNotificationSound(): void {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.05;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.12);
    osc.onended = () => ctx.close();
  } catch {
    /* sound is best-effort; never throw into the poller */
  }
}
