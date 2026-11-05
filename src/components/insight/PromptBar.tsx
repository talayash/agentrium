import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Send, Square, TerminalSquare } from 'lucide-react';
import { interruptAgent, sendPrompt } from '../../lib/promptSend';
import { reportInvokeFailure } from '../../lib/errorReporter';
import { useInsightStore } from '../../store/insightStore';
import { toast } from '../../store/toastStore';

const MAX_HEIGHT_PX = 8 * 20;
const FOCUS_RING = 'focus:outline-none focus-visible:ring-[3px] focus-visible:ring-accent-primary/45';

interface Props {
  terminalId: string;
  disabledReason: string | null;
  busy: boolean;
  onShowTerminal: () => void;
}

/** Imperative handle so the insight-only view can move focus to the bar. */
export interface PromptBarHandle {
  focus: () => void;
}

export const PromptBar = forwardRef<PromptBarHandle, Props>(function PromptBar(
  { terminalId, disabledReason, busy, onShowTerminal },
  handle,
) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(handle, () => ({ focus: () => ref.current?.focus() }), []);
  const sending = useRef(false);
  // null = not walking history; otherwise index into the history list.
  const histIdx = useRef<number | null>(null);
  const draft = useRef('');
  const disabled = disabledReason !== null;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [text]);

  const fail = (err: unknown) => {
    toast.error('Could not send to the terminal');
    reportInvokeFailure('write_to_terminal', err);
  };

  const send = async () => {
    if (disabled || sending.current || text.trim() === '') return;
    const sent = text;
    sending.current = true;
    useInsightStore.getState().pushPromptHistory(terminalId, sent.trimEnd());
    histIdx.current = null;
    draft.current = '';
    setText('');
    try {
      await sendPrompt(terminalId, sent);
    } catch (err) {
      setText(sent);
      fail(err);
    } finally {
      sending.current = false;
    }
  };

  const stop = () => {
    interruptAgent(terminalId).catch(fail);
  };

  const walk = (dir: -1 | 1): boolean => {
    const hist = useInsightStore.getState().promptHistory(terminalId);
    const cur = histIdx.current;
    if (dir === -1) {
      if (hist.length === 0) return false;
      if (cur === null) draft.current = text;
      const next = cur === null ? hist.length - 1 : Math.max(0, cur - 1);
      histIdx.current = next;
      setText(hist[next]!);
      return true;
    }
    if (cur === null) return false;
    if (cur >= hist.length - 1) {
      histIdx.current = null;
      setText(draft.current);
    } else {
      histIdx.current = cur + 1;
      setText(hist[cur + 1]!);
    }
    return true;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      if (busy) {
        e.stopPropagation();
        e.preventDefault();
        stop();
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
      return;
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const { selectionStart, selectionEnd, value } = e.currentTarget;
      if (selectionStart !== selectionEnd) return;
      if (e.key === 'ArrowUp') {
        const onFirstLine = value === '' || !value.slice(0, selectionStart).includes('\n');
        if (onFirstLine && walk(-1)) e.preventDefault();
      } else {
        const onLastLine = !value.slice(selectionEnd).includes('\n');
        if (onLastLine && walk(1)) e.preventDefault();
      }
    }
  };

  return (
    <div className="flex items-end gap-2 border-t border-seam bg-elevation-1 px-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder="Message the agent"
          aria-label="Message the agent"
          onChange={(e) => { setText(e.target.value); histIdx.current = null; }}
          onKeyDown={onKeyDown}
          className={`w-full resize-none rounded-md border border-seam bg-elevation-2 px-3 py-2 text-[13px] leading-5 text-text-primary placeholder:text-text-tertiary disabled:opacity-60 ${FOCUS_RING}`}
        />
        {disabledReason && <span className="text-[11px] text-text-tertiary">{disabledReason}</span>}
      </div>
      {busy && (
        <button
          type="button"
          onClick={stop}
          aria-label="Stop"
          title="Stop (Esc)"
          className={`flex h-9 items-center gap-1 rounded-md border border-seam px-2.5 text-[12px] text-text-secondary hover:bg-elevation-2 ${FOCUS_RING}`}
        >
          <Square size={12} aria-hidden /> Stop
        </button>
      )}
      <button
        type="button"
        onClick={() => void send()}
        disabled={disabled}
        aria-label="Send"
        title="Send (Enter)"
        className={`flex h-9 items-center gap-1 rounded-md bg-accent-primary px-2.5 text-[12px] text-white disabled:opacity-50 ${FOCUS_RING}`}
      >
        <Send size={12} aria-hidden /> Send
      </button>
      <button
        type="button"
        onClick={onShowTerminal}
        aria-label="Show terminal"
        title="Show terminal"
        className={`flex h-9 items-center gap-1 rounded-md border border-seam px-2.5 text-[12px] text-text-secondary hover:bg-elevation-2 ${FOCUS_RING}`}
      >
        <TerminalSquare size={12} aria-hidden /> Terminal
      </button>
    </div>
  );
});
