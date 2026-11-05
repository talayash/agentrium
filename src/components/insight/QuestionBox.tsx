import { useRef, useState, type KeyboardEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { buildInsightModel, type AskQuestion, type PendingQuestion } from '../../lib/insightModel';
import { buildAnswerKeys, type QuestionAnswer } from '../../lib/questionKeys';
import { reportInvokeFailure } from '../../lib/errorReporter';
import { readBufferTail } from '../../hooks/useSessionStateDetection';
import { useInsightStore } from '../../store/insightStore';
import { useTerminalStore } from '../../store/terminalStore';
import { toast } from '../../store/toastStore';
import { BarChart } from './charts';
import { MiniMarkdown } from './MiniMarkdown';

const FOCUS_RING =
  'focus:outline-none focus-visible:ring-[3px] focus-visible:ring-accent-primary/45';
const RECOMMENDED = '(Recommended)';
const SCREEN_TAIL_ROWS = 40;
const MATCH_PREFIX = 40;

const collapse = (t: string) => t.replace(/\s+/g, ' ').trim();

/** True when the terminal's visible tail still shows the first question (or its header). */
function questionOnScreen(terminalId: string, q: AskQuestion | undefined): boolean {
  const xterm = useTerminalStore.getState().terminals.get(terminalId)?.xterm;
  if (!xterm || !q) return false;
  const screenText = collapse(readBufferTail(xterm, SCREEN_TAIL_ROWS).join(' '));
  const needle = collapse(q.question).slice(0, MATCH_PREFIX);
  const header = collapse(q.header);
  return (needle !== '' && screenText.includes(needle)) || (header !== '' && screenText.includes(header));
}

interface Draft { selected: number[]; other: string }

/** Chart data when every option description holds exactly one number with the same unit. */
function comparisonItems(q: AskQuestion): { label: string; value: number }[] | null {
  if (q.options.length < 2) return null;
  const items: { label: string; value: number }[] = [];
  let unit: string | null = null;
  for (const o of q.options) {
    const found = [...o.description.matchAll(/(\d+(?:\.\d+)?)(?:\s?(%|MB|ms|s)(?![A-Za-z]))?/g)];
    if (found.length !== 1) return null;
    const u = found[0]![2] ?? '';
    if (unit !== null && u !== unit) return null;
    unit = u;
    items.push({ label: o.label.replace(RECOMMENDED, '').trim(), value: Number(found[0]![1]) });
  }
  return items;
}

function splitRecommended(label: string): { text: string; recommended: boolean } {
  const i = label.indexOf(RECOMMENDED);
  if (i < 0) return { text: label, recommended: false };
  return { text: (label.slice(0, i) + label.slice(i + RECOMMENDED.length)).trim(), recommended: true };
}

const hasPreview = (q: AskQuestion) => q.options.some((o) => o.preview !== undefined);
const isAnswered = (d: Draft) => d.selected.length > 0 || d.other.trim() !== '';

function QuestionBoxInner({ terminalId, pending }: { terminalId: string; pending: PendingQuestion }) {
  const sessionState = useTerminalStore((s) => s.terminalStates.get(terminalId));
  const [drafts, setDrafts] = useState<Draft[]>(() => pending.questions.map(() => ({ selected: [], other: '' })));
  const [sent, setSent] = useState(false);
  const inFlight = useRef(false);

  if (sessionState !== 'waiting') return null;

  const update = (qi: number, fn: (d: Draft) => Draft) =>
    setDrafts((cur) => cur.map((d, i) => (i === qi ? fn(d) : d)));

  const canSubmit = !sent && drafts.every(isAnswered);

  const submit = async () => {
    if (inFlight.current || !canSubmit) return;
    // Re-read the stores: the question may have been answered in the terminal meanwhile.
    const records = useInsightStore.getState().byId.get(terminalId)?.records ?? [];
    const stillPending = buildInsightModel(records).pendingQuestion?.toolUseId === pending.toolUseId;
    const ts = useTerminalStore.getState();
    if (!stillPending || ts.terminalStates.get(terminalId) !== 'waiting') return;

    // A dangling question from a killed session must never receive keystrokes
    // meant for an unrelated prompt: confirm it is really on screen.
    if (!questionOnScreen(terminalId, pending.questions[0])) {
      toast.info('The question is no longer on screen');
      return;
    }

    inFlight.current = true;
    setSent(true);
    try {
      const answers: QuestionAnswer[] = pending.questions.map((q, i) => {
        const d = drafts[i]!;
        const other = !hasPreview(q) && d.other.trim() !== '' ? d.other : null;
        return { selected: d.selected, other };
      });
      await ts.sendKeySequence(terminalId, buildAnswerKeys(pending.questions, answers));
      useTerminalStore.getState().terminals.get(terminalId)?.xterm?.focus();
    } catch (err) {
      toast.error('Could not send your answer', String(err));
      reportInvokeFailure('write_to_terminal', err);
      inFlight.current = false;
      setSent(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      useTerminalStore.getState().terminals.get(terminalId)?.xterm?.focus();
    } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div
      role="group"
      aria-label="Claude is asking a question"
      onKeyDown={onKeyDown}
      className="rounded-lg border border-seam bg-elevation-1 p-3 space-y-4"
    >
      {pending.questions.map((q, qi) => {
        const d = drafts[qi]!;
        const chart = comparisonItems(q);
        const preview = hasPreview(q);
        const cards = q.options.map((o, oi) => {
          const on = d.selected.includes(oi);
          const { text, recommended } = splitRecommended(o.label);
          const cls = `text-left rounded-lg bg-elevation-2 p-2 min-w-[160px] flex-1 basis-[160px] transition-colors hover:bg-fill-hover ${FOCUS_RING} ${
            on ? 'border-2 border-accent-primary' : 'border-2 border-seam'
          }`;
          const body = (
            <>
              <span className="flex items-center gap-1.5 text-[12px] font-medium text-text-primary">
                {text}
                {recommended && (
                  <span className="rounded bg-accent-primary/15 px-1 text-[10px] text-accent-primary">{RECOMMENDED}</span>
                )}
              </span>
              <span className="block text-[11px] text-text-secondary mt-0.5">{o.description}</span>
              {o.preview !== undefined && (
                <pre className="mt-1.5 max-h-40 overflow-auto rounded bg-elevation-1 p-1.5 text-[11px] text-text-secondary whitespace-pre-wrap">
                  <MiniMarkdown text={o.preview} />
                </pre>
              )}
            </>
          );
          if (q.multiSelect) {
            return (
              <button
                key={oi}
                type="button"
                aria-pressed={on}
                disabled={sent}
                className={cls}
                onClick={() =>
                  update(qi, (cur) => ({
                    ...cur,
                    selected: on ? cur.selected.filter((x) => x !== oi) : [...cur.selected, oi],
                  }))
                }
              >
                {body}
              </button>
            );
          }
          return (
            <button
              key={oi}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={sent}
              className={cls}
              onClick={() => update(qi, () => ({ selected: [oi], other: '' }))}
            >
              {body}
            </button>
          );
        });

        return (
          <section key={qi} className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="rounded bg-elevation-3 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-tertiary">
                {q.header}
              </span>
              <span className="text-[13px] text-text-primary">{q.question}</span>
            </div>
            {q.multiSelect ? (
              <div className="flex flex-wrap gap-2">{cards}</div>
            ) : (
              <div role="radiogroup" aria-label={q.question} className="flex flex-wrap gap-2">{cards}</div>
            )}
            {chart && <BarChart items={chart} />}
            {!preview && (
              <input
                type="text"
                aria-label={`Other answer for: ${q.question}`}
                placeholder="Other answer"
                value={d.other}
                disabled={sent}
                onChange={(e) =>
                  update(qi, (cur) => ({
                    selected: q.multiSelect ? cur.selected : e.target.value.trim() !== '' ? [] : cur.selected,
                    other: e.target.value,
                  }))
                }
                className={`w-full bg-elevation-2 ring-1 ring-seam rounded-lg h-8 px-2 text-text-primary text-[12px] placeholder:text-text-tertiary focus:outline-none focus:ring-[3px] focus:ring-accent-primary/45`}
              />
            )}
          </section>
        );
      })}
      <div className="flex justify-end">
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => void submit()}
          className={`inline-flex items-center gap-1.5 rounded-lg bg-accent-primary px-3 h-8 text-[12px] font-medium text-white disabled:opacity-50 ${FOCUS_RING}`}
        >
          {sent && <Loader2 size={13} className="animate-spin" />}
          Answer
        </button>
      </div>
    </div>
  );
}

export function QuestionBox({ terminalId, pending }: { terminalId: string; pending: PendingQuestion }) {
  // Keyed so a new question starts with a fresh draft and a fresh sent state.
  return <QuestionBoxInner key={pending.toolUseId} terminalId={terminalId} pending={pending} />;
}
