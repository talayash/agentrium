import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/appStore';
import { useLearnStore } from '../../store/learnStore';
import { useTerminalStore } from '../../store/terminalStore';
import { KIND_SHORT, LEVEL_LABELS, STATUS_MESSAGE } from '../../lib/learn';
import type { LearnLevel } from '../../lib/learn';
import { LessonCardView } from './LessonCard';
import { LearnConsent } from './LearnConsent';

export function LearnPanel() {
  const terminalId = useTerminalStore((s) => s.activeTerminalId);
  const goal = useTerminalStore((s) => (s.activeTerminalId ? s.terminals.get(s.activeTerminalId)?.sessionContext?.goal : undefined));
  const entry = useLearnStore((s) => (terminalId ? s.byTerminal[terminalId] : undefined));
  const { load, generate, markSeen, answer, toggleSave } = useLearnStore.getState();
  const level = useAppStore((s) => s.learnLevel);
  const setLevel = useAppStore((s) => s.setLearnLevel);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (terminalId && !entry) void load(terminalId);
  }, [terminalId, entry, load]);
  useEffect(() => {
    if (terminalId && entry?.unseen) markSeen(terminalId);
  }, [terminalId, entry?.unseen, markSeen]);
  const cardCount = entry?.cards.length ?? 0;
  useEffect(() => setIndex(0), [terminalId, cardCount]);

  if (!terminalId) {
    return <p className="p-4 text-[13px] text-text-tertiary">Open a session to learn from its changes.</p>;
  }

  const status = entry?.status ?? 'idle';
  const cards = entry?.cards ?? [];
  const card = cards[Math.min(index, Math.max(cards.length - 1, 0))];
  const run = () => void generate(terminalId, { goal });

  return (
    <div className="h-full overflow-y-auto p-4 flex flex-col gap-3.5">
      <div role="group" aria-label="Level" className="flex gap-1 p-0.5 rounded-lg bg-fill-hover/40">
        {LEVEL_LABELS.map((label, i) => (
          <button
            key={label}
            type="button"
            aria-pressed={level === i}
            onClick={() => setLevel(i as LearnLevel)}
            className={`flex-1 h-8 rounded-md text-[12px] ${level === i ? 'bg-fill-active text-text-primary font-semibold' : 'text-text-tertiary hover:text-text-primary'}`}
          >
            {label}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={run}
        disabled={status === 'loading'}
        className="h-9 rounded-lg border border-[var(--seam)] text-[12px] text-text-primary hover:bg-fill-hover disabled:opacity-50"
      >
        Learn from current changes
      </button>

      {status === 'no_consent' && <LearnConsent onAllowed={run} />}
      {status === 'loading' && <p className="text-[13px] text-text-tertiary">Reading the diff and writing lessons...</p>}
      {status !== 'loading' && status !== 'idle' && status !== 'ok' && status !== 'no_consent' && (
        <p className="text-[13px] text-text-tertiary">{STATUS_MESSAGE[status]}</p>
      )}
      {status === 'idle' && cards.length === 0 && (
        <p className="text-[13px] text-text-tertiary">Run an agent, then press Learn from current changes.</p>
      )}

      {card && (
        <>
          <div className="flex flex-wrap gap-1.5">
            {cards.map((c, i) => (
              <button
                key={c.id}
                type="button"
                aria-pressed={c.id === card.id}
                onClick={() => setIndex(i)}
                className={`h-8 px-3 rounded-full border text-[12px] ${c.id === card.id ? 'border-accent-primary text-text-primary font-semibold' : 'border-[var(--seam)] text-text-tertiary'}`}
              >
                {`${i + 1} ${KIND_SHORT[c.kind]}`}
              </button>
            ))}
          </div>
          <LessonCardView
            card={card}
            level={level}
            onPick={(i) => void answer(terminalId, card.id, i)}
            onToggleSave={() => void toggleSave(terminalId, card.id)}
            onLevel={setLevel}
            onNext={() => setIndex((i) => (i + 1) % cards.length)}
          />
          <span className="text-[11px] leading-relaxed text-text-tertiary">
            Generated with your Claude CLI. Quoted lines are checked against the diff.
          </span>
        </>
      )}
    </div>
  );
}
