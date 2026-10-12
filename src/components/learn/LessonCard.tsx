import type { LearnLevel, LessonCard } from '../../lib/learn';
import { KIND_LABEL } from '../../lib/learn';

interface Props {
  card: LessonCard;
  level: LearnLevel;
  onPick: (index: number) => void;
  onToggleSave: () => void;
  onLevel: (level: LearnLevel) => void;
  onNext: () => void;
}

const ghostBtn =
  'h-9 px-3 rounded-lg border border-[var(--seam)] text-[12px] text-text-primary hover:bg-fill-hover disabled:opacity-40 disabled:hover:bg-transparent';

export function LessonCardView({ card, level, onPick, onToggleSave, onLevel, onNext }: Props) {
  const answered = card.answeredIndex !== null;
  const correct = answered && card.answeredIndex === card.answerIndex;
  const highlighted = new Set(card.highlight);

  return (
    <article className="flex flex-col gap-3 p-4 rounded-xl border border-[var(--seam)] bg-fill-hover/40">
      <span className="text-[11px] uppercase tracking-wider font-semibold text-accent-primary">{KIND_LABEL[card.kind]}</span>
      <h3 className="m-0 text-[15px] font-semibold text-text-primary leading-snug">{card.title}</h3>

      <div className="rounded-lg border border-[var(--seam)] overflow-x-auto font-mono text-[12px]">
        <div className="flex justify-between px-2.5 py-1.5 border-b border-[var(--seam)] text-[11px] text-text-tertiary">
          <span>{`${card.filePath}:${card.startLine}-${card.endLine}`}</span>
          <span>from diff</span>
        </div>
        <div className="py-1.5">
          {card.quote.map((line, i) => {
            const n = card.startLine + i;
            return (
              <div key={n} className={`flex whitespace-pre pr-3 ${highlighted.has(n) ? 'bg-accent-primary/15' : ''}`}>
                <span className="w-9 shrink-0 pr-3 text-right text-text-tertiary select-none">{n}</span>
                <span className="text-text-secondary">{line}</span>
              </div>
            );
          })}
        </div>
      </div>

      <p className="m-0 text-[13px] leading-relaxed text-text-secondary">{card.why[level]}</p>

      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-semibold text-text-primary">Predict first: {card.question}</span>
        {card.options.map((opt, i) => {
          const isAnswer = i === card.answerIndex;
          const isPicked = i === card.answeredIndex;
          const tone = !answered
            ? 'border-[var(--seam)] text-text-primary hover:bg-fill-hover'
            : isAnswer
              ? 'border-success text-text-primary bg-success/10'
              : isPicked
                ? 'border-error text-text-primary bg-error/10'
                : 'border-[var(--seam)] text-text-tertiary';
          return (
            <button
              key={i}
              type="button"
              disabled={answered}
              aria-pressed={isPicked}
              onClick={() => onPick(i)}
              className={`min-h-10 px-3 py-2 rounded-lg border text-left text-[13px] ${tone}`}
            >
              {opt}
            </button>
          );
        })}
        {answered ? (
          <div className="px-3 py-2.5 rounded-lg bg-success/10 text-[13px] leading-relaxed text-text-primary">
            {correct ? 'Correct.' : 'Not quite.'} {card.explain}
          </div>
        ) : (
          <span className="text-[12px] text-text-tertiary">Pick an answer to reveal why.</span>
        )}
      </div>

      <div className="flex flex-wrap gap-2 pt-1">
        <button type="button" className={ghostBtn} disabled={level === 0} onClick={() => onLevel((level - 1) as LearnLevel)}>
          Explain simpler
        </button>
        <button type="button" className={ghostBtn} disabled={level === 2} onClick={() => onLevel((level + 1) as LearnLevel)}>
          Go deeper
        </button>
        <button type="button" className={ghostBtn} aria-pressed={card.saved} onClick={onToggleSave}>
          {card.saved ? 'Saved' : 'Save card'}
        </button>
        <button
          type="button"
          onClick={onNext}
          className="ml-auto h-9 px-3.5 rounded-lg border border-accent-primary bg-accent-primary/15 text-text-primary text-[12px] font-semibold hover:bg-accent-primary/25"
        >
          Next card
        </button>
      </div>
    </article>
  );
}
