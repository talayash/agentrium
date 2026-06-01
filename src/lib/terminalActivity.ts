// Module-level activity tracker for the "Claude is working" tab indicator.
// We deliberately bypass Zustand here: terminalStore.handleTerminalOutput is
// invoked thousands of times per second on streaming chunks, and the existing
// code carefully short-circuits Zustand set() calls. Recording a timestamp in
// a plain Map avoids that re-render cost entirely.
//
// Consumers (useNowTick + TerminalTabs) read this map on a 500ms tick - no
// reactive subscription needed since the tick itself drives the re-render.

const lastOutputAtByTerminal = new Map<string, number>();

export function markTerminalActive(id: string): void {
  lastOutputAtByTerminal.set(id, Date.now());
}

export function getLastOutputAt(id: string): number | undefined {
  return lastOutputAtByTerminal.get(id);
}

export function clearTerminalActivity(id: string): void {
  lastOutputAtByTerminal.delete(id);
}

export function getActiveTerminalIds(windowMs: number): string[] {
  const now = Date.now();
  const out: string[] = [];
  for (const [id, ts] of lastOutputAtByTerminal) {
    if (now - ts < windowMs) out.push(id);
  }
  return out;
}
