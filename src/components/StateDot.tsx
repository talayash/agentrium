import type { SessionState } from '../lib/terminalState';

const DOT: Record<SessionState, { cls: string; pulse: boolean; title: string }> = {
  busy:    { cls: 'bg-success',          pulse: true,  title: 'Claude is working…' },
  waiting: { cls: 'bg-amber-400',        pulse: true,  title: 'Claude needs your input' },
  idle:    { cls: 'bg-text-tertiary/40', pulse: false, title: 'Idle' },
  stopped: { cls: 'bg-text-tertiary',    pulse: false, title: 'Stopped' },
};

export function StateDot({ state, size = 8 }: { state: SessionState; size?: number }) {
  const d = DOT[state];
  return (
    <span
      className={`rounded-full flex-shrink-0 ${d.cls} ${d.pulse ? 'ct-working-dot' : ''}`}
      style={{ width: size, height: size }}
      title={d.title}
    />
  );
}
